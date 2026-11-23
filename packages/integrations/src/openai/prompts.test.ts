import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadPlatformConstraints } from '@platform/contracts/node';
import {
  BUSINESS_OWNER_INSTRUCTIONS,
  RESEARCHER_INSTRUCTIONS,
  researcherInput,
} from './prompts.js';

const constraints = loadPlatformConstraints(
  fileURLToPath(new URL('../../../../config/platform-constraints.json', import.meta.url)),
);

describe('role instructions', () => {
  it('tell the researcher the product is built by agents, so no human labor is costed', () => {
    expect(RESEARCHER_INSTRUCTIONS).toMatch(/built and operated by AI agents/);
    expect(RESEARCHER_INSTRUCTIONS).toMatch(/Never assume or cost human labor/);
  });

  it('keep the preferred provider unless another is clearly cheaper, with cited prices', () => {
    expect(RESEARCHER_INSTRUCTIONS).toMatch(
      /hosting\.preferredProvider unless another provider is clearly\s+cheaper/,
    );
    expect(RESEARCHER_INSTRUCTIONS).toMatch(/cite the pricing pages/);
    expect(RESEARCHER_INSTRUCTIONS).toMatch(/Free tiers that forbid commercial use do not count/);
  });

  it('make the business owner reject plans that rely on unpaid owner hours or unjustified providers', () => {
    expect(BUSINESS_OWNER_INSTRUCTIONS).toMatch(/unpaid human hours/);
    expect(BUSINESS_OWNER_INSTRUCTIONS).toMatch(/clearly lower, cited cost/);
  });
});

describe('researcherInput', () => {
  it('shows the candidate providers and limits but never the agents own allowance', () => {
    const input = researcherInput('a goal', constraints);
    expect(input).toContain(
      '"candidateProviders":["aws","cloudflare","vercel","fly-io","render","supabase"]',
    );
    expect(input).toContain('"buildBudgetUsd":50');
    expect(input).not.toContain('agentSpend');
  });
});
