import type { LlmConfig } from '../models.ts';
import { extractEntityAnchors, extractRequestAnchors } from './anchors.ts';
import { splitDialogue } from './chunking/split.ts';
import { mergeDetectedValues } from './detected-values.ts';
import type { LlmClient } from './llm/client.ts';
import { pLimit } from './pool.ts';
import {
  ANALYSIS_SYSTEM_PROMPT,
  buildMapPrompt,
  buildReducePrompt,
  buildSinglePrompt,
} from './prompts.ts';
import {
  ANALYSIS_DRAFT_SCHEMA,
  type AnalysisDraft,
  coerceAnalysisDraft,
  serializeAnalysisMarkdown,
} from './sections.ts';

const RESPONSE_TOKEN_RESERVE = 4096;
const CONTEXT_ROUNDING_TOKENS = 1024;

function estimatedTokens(text: string, charsPerToken: number): number {
  return Math.ceil(text.length / charsPerToken);
}

function requestTokens(user: string, config: LlmConfig): number {
  return estimatedTokens(ANALYSIS_SYSTEM_PROMPT + user, config.charsPerToken) + RESPONSE_TOKEN_RESERVE;
}

function roundedContext(tokens: number): number {
  return Math.ceil(tokens / CONTEXT_ROUNDING_TOKENS) * CONTEXT_ROUNDING_TOKENS;
}

function hasStructuredSpeakerLabels(transcript: string): boolean {
  return transcript.split(/\r?\n/).some((line) => (
    /^(?:\[[^\]]+\]|(?:speaker|konuşmacı)[ _-]?\d+|[\p{L}][\p{L} .'-]{0,40}):\s+/iu.test(line.trim())
  ));
}

export function removeUnlabeledSpeakerAttributions(
  draft: AnalysisDraft,
  transcript: string,
): AnalysisDraft {
  if (hasStructuredSpeakerLabels(transcript)) return draft;

  const attribution = /\s*\((?:konuşmacı|speaker)\s*:[^)]+\)\.?\s*$/iu;
  const moved: string[] = [];
  const actionItems = draft.actionItems.filter((item) => {
    if (!attribution.test(item)) return true;
    const cleaned = item.replace(attribution, '').trim();
    if (cleaned) moved.push(cleaned);
    return false;
  });
  const nextSteps = [...draft.nextSteps];
  for (const item of moved) {
    if (!nextSteps.some((existing) => existing.toLocaleLowerCase('tr-TR') === item.toLocaleLowerCase('tr-TR'))) {
      nextSteps.push(item);
    }
  }
  return { ...draft, actionItems, nextSteps };
}

export function shouldUseSinglePass(transcript: string, config: LlmConfig): boolean {
  const user = buildSinglePrompt(
    transcript,
    extractRequestAnchors(transcript),
    extractEntityAnchors(transcript),
  );
  return requestTokens(user, config) <= config.numCtx;
}

async function requestDraft(
  client: LlmClient,
  user: string,
  config: LlmConfig,
  allowContextGrowth = false,
): Promise<AnalysisDraft> {
  const needed = requestTokens(user, config);
  const numCtx = allowContextGrowth ? Math.max(config.numCtx, roundedContext(needed)) : config.numCtx;
  const raw = await client.chat({
    system: ANALYSIS_SYSTEM_PROMPT,
    user,
    schema: ANALYSIS_DRAFT_SCHEMA as unknown as Record<string, unknown>,
    numCtx,
  });
  return coerceAnalysisDraft(raw);
}

function reduceFits(
  drafts: AnalysisDraft[],
  requestAnchors: string[],
  entityAnchors: string[],
  config: LlmConfig,
): boolean {
  return requestTokens(buildReducePrompt(drafts, requestAnchors, entityAnchors), config) <= config.numCtx;
}

function groupForReduce(drafts: AnalysisDraft[], config: LlmConfig): AnalysisDraft[][] {
  const groups: AnalysisDraft[][] = [];
  let current: AnalysisDraft[] = [];
  for (const draft of drafts) {
    const candidate = [...current, draft];
    if (current.length > 0 && !reduceFits(candidate, [], [], config)) {
      groups.push(current);
      current = [draft];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

async function reduceDrafts(
  initial: AnalysisDraft[],
  requestAnchors: string[],
  entityAnchors: string[],
  client: LlmClient,
  config: LlmConfig,
): Promise<AnalysisDraft> {
  let drafts = initial;
  const limit = pLimit(config.mapConcurrency);

  while (!reduceFits(drafts, requestAnchors, entityAnchors, config)) {
    const groups = groupForReduce(drafts, config);
    if (groups.every((group) => group.length === 1)) {
      return requestDraft(
        client,
        buildReducePrompt(drafts, requestAnchors, entityAnchors),
        config,
        true,
      );
    }
    drafts = await Promise.all(groups.map((group) => (
      group.length === 1
        ? Promise.resolve(group[0])
        : limit(() => requestDraft(client, buildReducePrompt(group, [], []), config))
    )));
  }

  return requestDraft(
    client,
    buildReducePrompt(drafts, requestAnchors, entityAnchors),
    config,
  );
}

export async function analyzeTranscript(
  transcript: string,
  client: LlmClient,
  config: LlmConfig,
): Promise<string> {
  const requestAnchors = extractRequestAnchors(transcript);
  const entityAnchors = extractEntityAnchors(transcript);

  if (shouldUseSinglePass(transcript, config)) {
    const draft = await requestDraft(
      client,
      buildSinglePrompt(transcript, requestAnchors, entityAnchors),
      config,
    );
    draft.detectedValues = mergeDetectedValues(draft.detectedValues, entityAnchors, transcript);
    return serializeAnalysisMarkdown(removeUnlabeledSpeakerAttributions(draft, transcript));
  }

  const promptTokens = estimatedTokens(ANALYSIS_SYSTEM_PROMPT, config.charsPerToken);
  const maxChunkTokens = Math.max(
    128,
    Math.min(config.chunkTokens, config.numCtx - RESPONSE_TOKEN_RESERVE - promptTokens - 512),
  );
  const chunks = splitDialogue(transcript, {
    maxTokens: maxChunkTokens,
    overlapTokens: Math.min(config.chunkOverlapTokens, Math.floor(maxChunkTokens / 4)),
    charsPerToken: config.charsPerToken,
  });
  const limit = pLimit(config.mapConcurrency);
  const mapped = await Promise.all(chunks.map((chunk, index) => (
    limit(() => requestDraft(client, buildMapPrompt(chunk, index, chunks.length), config))
  )));
  const finalDraft = await reduceDrafts(mapped, requestAnchors, entityAnchors, client, config);
  finalDraft.detectedValues = mergeDetectedValues(finalDraft.detectedValues, entityAnchors, transcript);
  return serializeAnalysisMarkdown(removeUnlabeledSpeakerAttributions(finalDraft, transcript));
}
