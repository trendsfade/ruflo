/**
 * Workflow E2E — Step 17 (ADR-093).
 *
 * Tests every workflow listed in `docs/workflow-inventory.md` (W-1
 * through W-4 — W-5 has no client callsite and is deferred to
 * Step 21's "delete vs keep public API" decision).
 *
 * Approach:
 *
 *   W-1  Generate suggested goal — full UI flow. Click a category
 *        button, assert toast + goal textarea state.
 *
 *   W-2/W-3/W-4  Heavier UI prerequisites (multi-step plan run,
 *        report modal, Advanced settings dialog). For DoD breadth
 *        we mock the endpoint via Playwright `page.route()` and
 *        invoke `supabase.functions.invoke(...)` directly via
 *        `page.evaluate` — verifies request URL pattern + response
 *        handling without dragging in unrelated UI state. Phase 4
 *        replaces these workflows entirely (Step 19 ports to
 *        LOCAL_FN/GCF), at which point the UI-flow tests become
 *        cheap to add.
 *
 * Each workflow gets a happy-path test + an error-path test (DoD).
 *
 * Mock URL pattern: matches `https://*.supabase.co/functions/v1/<name>`
 * regardless of project id (example.env uses a placeholder, real
 * deployments use the project's id).
 */

import { test, expect, type Route } from '@playwright/test';

const FN_BASE = '**/functions/v1';

/** Stub a function endpoint with a JSON body + status. */
function stubFn(name: string, body: unknown, status = 200) {
  return async (route: Route) => {
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  };
}

// ─── W-1 — Generate suggested goal from category ──────────────────────
//
// W-1 tests fire two parallel `supabase.functions.invoke()` calls
// (generate-research-goal + optimize-research-config) and assert
// state changes that depend on both completing. Under heavy parallel
// load (6 Playwright workers + Vite HMR), 5 s wasn't enough — bumped
// asserts to 15 s. Route-mocked responses are still <50 ms; the
// extra budget covers dev-server first-paint variance.

test.describe('W-1 generate-research-goal — UI flow', () => {
  test('happy: Finance click sets goal text + shows success toast', async ({ page }) => {
    await page.route(`${FN_BASE}/generate-research-goal`,
      stubFn('generate-research-goal', { goals: ['Investigate AI trends in fintech sector 2025'] }));
    await page.route(`${FN_BASE}/optimize-research-config`,
      stubFn('optimize-research-config', { config: { researchGuidance: { focusAreas: ['fintech'] } } }));

    await page.goto('/');
    await page.getByRole('button', { name: /finance/i }).first().click();

    // Goal textarea (the GoalInput one, NOT widgetConfig customizer fields)
    const textbox = page.getByRole('textbox').first();
    await expect(textbox).toHaveValue(/fintech/i, { timeout: 15000 });

    // Success toast — sonner toast emits a region with the title text
    await expect(page.getByText(/Goal & Settings Optimized/i).first()).toBeVisible({ timeout: 15000 });
  });

  test('error: 429 from generate-research-goal shows failure toast', async ({ page }) => {
    await page.route(`${FN_BASE}/generate-research-goal`,
      stubFn('generate-research-goal', { error: 'Rate limits exceeded. Please try again later.' }, 429));
    await page.route(`${FN_BASE}/optimize-research-config`,
      stubFn('optimize-research-config', { config: {} }, 429));

    await page.goto('/');
    await page.getByRole('button', { name: /business/i }).first().click();

    // Failure toast
    await expect(page.getByText(/Generation Failed/i).first()).toBeVisible({ timeout: 15000 });
  });
});

// ─── W-2 — research-step (per-step LLM call) ──────────────────────────

test.describe('W-2 research-step — invocation contract', () => {
  test('happy: client receives array of data items', async ({ page }) => {
    let captured: { url: string; method: string } | null = null;
    await page.route(`${FN_BASE}/research-step`, async (route) => {
      captured = { url: route.request().url(), method: route.request().method() };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { title: 'Finding A', content: 'detail', source: 'src1', confidence: 0.9 },
        ]),
      });
    });

    await page.goto('/');
    const result = await page.evaluate(async () => {
      const sb = await import('/src/integrations/supabase/client.ts');
      const { data, error } = await sb.supabase.functions.invoke('research-step', {
        body: { goal: 'g', stepTitle: 't', stepDescription: 'd', stepType: 'st' },
      });
      return { dataLen: Array.isArray(data) ? data.length : -1, error: error?.message ?? null };
    });

    expect(captured).not.toBeNull();
    expect(captured!.method).toBe('POST');
    expect(result.dataLen).toBe(1);
    expect(result.error).toBeNull();
  });

  test('error: 5xx propagates as error to caller', async ({ page }) => {
    await page.route(`${FN_BASE}/research-step`, async (route) => {
      await route.fulfill({ status: 500, contentType: 'application/json',
        body: JSON.stringify({ error: 'upstream model failure' }) });
    });

    await page.goto('/');
    const result = await page.evaluate(async () => {
      const sb = await import('/src/integrations/supabase/client.ts');
      const { data, error } = await sb.supabase.functions.invoke('research-step', {
        body: { goal: 'g', stepTitle: 't', stepDescription: 'd', stepType: 'st' },
      });
      return { hasData: !!data, hasError: !!error };
    });
    expect(result.hasError).toBe(true);
  });
});

// ─── W-3 — generate-action-items ──────────────────────────────────────

test.describe('W-3 generate-action-items — invocation contract', () => {
  test('happy: returns actionItems array', async ({ page }) => {
    await page.route(`${FN_BASE}/generate-action-items`,
      stubFn('generate-action-items', {
        actionItems: [
          { title: 'Action 1', description: 'd', priority: 'high', timeline: 'now' },
          { title: 'Action 2', description: 'd', priority: 'medium', timeline: 'q2' },
        ],
      }));

    await page.goto('/');
    const result = await page.evaluate(async () => {
      const sb = await import('/src/integrations/supabase/client.ts');
      const { data, error } = await sb.supabase.functions.invoke('generate-action-items', {
        body: { goal: 'g', researchContext: [], totalSteps: 0, totalDataPoints: 0 },
      });
      return {
        count: data?.actionItems?.length ?? -1,
        firstTitle: data?.actionItems?.[0]?.title ?? null,
        errMsg: error?.message ?? null,
      };
    });

    expect(result.count).toBe(2);
    expect(result.firstTitle).toBe('Action 1');
    expect(result.errMsg).toBeNull();
  });

  test('error: 402 quota path propagates to caller', async ({ page }) => {
    await page.route(`${FN_BASE}/generate-action-items`,
      stubFn('generate-action-items', { error: 'AI usage limit reached. Please add credits to continue.' }, 402));

    await page.goto('/');
    const result = await page.evaluate(async () => {
      const sb = await import('/src/integrations/supabase/client.ts');
      const { data, error } = await sb.supabase.functions.invoke('generate-action-items', {
        body: { goal: 'g', researchContext: [], totalSteps: 0, totalDataPoints: 0 },
      });
      return { hasError: !!error, hasData: !!data };
    });
    expect(result.hasError).toBe(true);
  });
});

// ─── W-4 — optimize-research-config preset trigger ────────────────────

test.describe('W-4 optimize-research-config — invocation contract', () => {
  test('happy: returns config payload with researchGuidance', async ({ page }) => {
    await page.route(`${FN_BASE}/optimize-research-config`,
      stubFn('optimize-research-config', {
        config: {
          researchGuidance: { depth: 'deep', perspective: 'academic', focusAreas: ['rigor'] },
        },
      }));

    await page.goto('/');
    const result = await page.evaluate(async () => {
      const sb = await import('/src/integrations/supabase/client.ts');
      const { data, error } = await sb.supabase.functions.invoke('optimize-research-config', {
        body: { preset: 'academic-deep', currentGoal: 'g' },
      });
      return {
        depth: data?.config?.researchGuidance?.depth ?? null,
        errMsg: error?.message ?? null,
      };
    });
    expect(result.depth).toBe('deep');
    expect(result.errMsg).toBeNull();
  });

  test('error: network abort reflects as error to caller', async ({ page }) => {
    await page.route(`${FN_BASE}/optimize-research-config`, async (route) => {
      await route.abort('failed');
    });

    await page.goto('/');
    const result = await page.evaluate(async () => {
      const sb = await import('/src/integrations/supabase/client.ts');
      const { data, error } = await sb.supabase.functions.invoke('optimize-research-config', {
        body: { preset: 'academic-deep' },
      });
      return { hasError: !!error, hasData: !!data };
    });
    expect(result.hasError).toBe(true);
  });
});
