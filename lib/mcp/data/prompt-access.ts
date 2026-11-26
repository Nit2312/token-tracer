/**
 * Prompt access mode (P3-1 contract). Pure.
 *
 * DEFAULT AND ONLY MODE TODAY: metadata. Prompt text is behind a gate with TWO independent conditions, both required:
 *   1. the environment flag MCP_PROMPT_TEXT_ENABLED is exactly "true" (default: unset = false), AND
 *   2. a recorded privacy/legal approval exists IN CODE (RECORDED_PROMPT_TEXT_APPROVAL), valid and for the current policy version.
 * The flag alone never enables text. The approval cannot come from the environment: recording it is a code change (a reviewed commit that also
 * updates MCP.md section 16), not a deployment setting. A test fails while the constant is anything but null, so granting it cannot happen by accident.
 * No text-bearing type exists in P3-1: this module only decides the mode.
 */
export const PROMPT_TEXT_POLICY_VERSION = 1 as const;
/** Wording version 1 overstates what masking does and is NOT acceptable for text access (decision 6, 2026-11-26). Corrected wording is version 2 or later. */
export const CONSENT_WORDING_MIN_VERSION = 2 as const;

export interface PromptTextApproval {
  /** Reference to the written privacy/legal approval (ticket, document id). */
  readonly reference: string;
  /** Two DIFFERENT named approvers: one for privacy, one for legal. One person cannot grant both. */
  readonly privacyApprovedBy: string;
  readonly legalApprovedBy: string;
  /** Version of the (corrected) consent wording shown to developers; must be at least CONSENT_WORDING_MIN_VERSION. */
  readonly consentWordingVersion: number;
  /** ISO date (YYYY-MM-DD) the approval was given. */
  readonly approvedOn: string;
  /** The approval applies to this version of the policy; a change to what is exposed needs a new approval. */
  readonly policyVersion: typeof PROMPT_TEXT_POLICY_VERSION;
  /** The approver acknowledged that masking is best-effort and cannot guarantee that no secret survives. */
  readonly maskingBestEffortAcknowledged: true;
}

/** `null` = NOT approved. Do not change this without written privacy/legal approval and an MCP.md update (section 16). */
export const RECORDED_PROMPT_TEXT_APPROVAL: PromptTextApproval | null = null;

export type PromptAccess =
  | { readonly mode: 'metadata' }
  | { readonly mode: 'text'; readonly approval: PromptTextApproval };

const METADATA_ONLY: PromptAccess = Object.freeze({ mode: 'metadata' as const });
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length >= 3 && v.length <= 200;

export function isValidApproval(a: unknown, now: Date = new Date()): a is PromptTextApproval {
  if (a === null || typeof a !== 'object') return false;
  const x = a as Record<string, unknown>;
  if (!nonEmpty(x.reference) || !nonEmpty(x.privacyApprovedBy) || !nonEmpty(x.legalApprovedBy)) return false;
  if ((x.privacyApprovedBy as string).trim().toLowerCase() === (x.legalApprovedBy as string).trim().toLowerCase()) return false;
  if (!Number.isInteger(x.consentWordingVersion) || (x.consentWordingVersion as number) < CONSENT_WORDING_MIN_VERSION) return false;
  if (typeof x.approvedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x.approvedOn)) return false;
  const when = Date.parse(`${x.approvedOn}T00:00:00Z`);
  if (!Number.isFinite(when) || new Date(when).toISOString().slice(0, 10) !== x.approvedOn || when > now.getTime()) return false;
  return x.policyVersion === PROMPT_TEXT_POLICY_VERSION && x.maskingBestEffortAcknowledged === true;
}

/** Metadata unless BOTH the flag is exactly "true" AND a valid recorded approval exists. Anything else — including malformed input — is metadata. */
export function resolvePromptAccess(
  env: Readonly<Record<string, string | undefined>>,
  approval: PromptTextApproval | null = RECORDED_PROMPT_TEXT_APPROVAL,
  now: Date = new Date(),
): PromptAccess {
  if (env.MCP_PROMPT_TEXT_ENABLED !== 'true') return METADATA_ONLY;
  if (!isValidApproval(approval, now)) return METADATA_ONLY;
  return Object.freeze({ mode: 'text' as const, approval });
}
