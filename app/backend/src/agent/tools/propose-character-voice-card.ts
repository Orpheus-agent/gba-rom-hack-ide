/**
 * propose_character_voice_card - Phase 3.21.
 *
 * Persists a per-character voice spec to
 * `<projectRoot>/.editor/voices/<characterId>.md`. The agent reads
 * this file before generating dialogue for the character; the file
 * survives across sessions so the agent's "voice" stays consistent
 * over time.
 *
 * The voice card is a structured markdown file with sections for
 * tone, vocabulary, speech patterns, and example lines. The tool's
 * persistence is best-effort - a write failure doesn't fail the
 * tool (mirrors the propose_story_spec pattern).
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { ToolContext } from '../types.js';

export const PROPOSE_CHARACTER_VOICE_CARD_TOOL_NAME = 'propose_character_voice_card';

export const PROPOSE_CHARACTER_VOICE_CARD_DESCRIPTION =
  'Persist a per-character voice spec so dialogue stays consistent across\n' +
  'sessions.\n\n' +
  'Inputs:\n' +
  '  - `characterId`: stable id (e.g. \'cosmog_bearer\', \'rival\').\n' +
  '  - `name`: display name.\n' +
  '  - `tone`: free-form description (\'kind and laconic\', \'archaic\',\n' +
  '    \'menacing but soft-spoken\').\n' +
  '  - `vocabulary.forbidden`: words this character never uses.\n' +
  '  - `vocabulary.preferred`: words this character favors.\n' +
  '  - `speechPatterns`: bullet-list of recognisable verbal tics\n' +
  '    (\'always speaks in present tense\', \'breaks sentences into\n' +
  '    fragments when shaken\').\n' +
  '  - `exampleLines`: 3-5 short lines that capture the voice.\n' +
  '  - `pokemonAssociations`: optional species ids the character\n' +
  '    is connected to (Cosmog bearer carries Cosmog).\n\n' +
  'Persisted to `<projectRoot>/.editor/voices/<characterId>.md`.';

export const proposeCharacterVoiceCardInputShape = {
  characterId: z.string().min(1).max(60),
  name: z.string().min(1).max(60),
  tone: z.string().min(1).max(300),
  vocabulary: z
    .object({
      forbidden: z.array(z.string()).max(40).optional(),
      preferred: z.array(z.string()).max(40).optional(),
    })
    .optional(),
  speechPatterns: z.array(z.string().min(1).max(200)).max(20).optional(),
  exampleLines: z.array(z.string().min(1).max(280)).min(1).max(10),
  pokemonAssociations: z.array(z.string()).max(20).optional(),
} as const;

export interface ProposeCharacterVoiceCardResult {
  readonly ok: boolean;
  readonly persistedPath: string | null;
  readonly markdown: string;
  readonly message: string;
}

export async function proposeCharacterVoiceCard(
  ctx: ToolContext,
  args: {
    characterId: string;
    name: string;
    tone: string;
    vocabulary?: { forbidden?: string[]; preferred?: string[] };
    speechPatterns?: string[];
    exampleLines: string[];
    pokemonAssociations?: string[];
  },
): Promise<ProposeCharacterVoiceCardResult> {
  // Validate the characterId is safe as a filename component.
  if (!/^[a-z0-9_-]+$/i.test(args.characterId)) {
    return {
      ok: false,
      persistedPath: null,
      markdown: '',
      message: `characterId "${args.characterId}" must be alphanumeric / underscore / hyphen only.`,
    };
  }

  const lines: string[] = [];
  lines.push(`# 🗣️ Voice card - ${args.name}`);
  lines.push('');
  lines.push(`**Character id:** \`${args.characterId}\``);
  lines.push('');
  lines.push(`**Tone:** ${args.tone}`);
  lines.push('');
  if (args.vocabulary?.forbidden?.length || args.vocabulary?.preferred?.length) {
    lines.push('## Vocabulary');
    if (args.vocabulary.forbidden?.length) {
      lines.push(`- **Forbidden:** ${args.vocabulary.forbidden.map((w) => `\`${w}\``).join(', ')}`);
    }
    if (args.vocabulary.preferred?.length) {
      lines.push(`- **Preferred:** ${args.vocabulary.preferred.map((w) => `\`${w}\``).join(', ')}`);
    }
    lines.push('');
  }
  if (args.speechPatterns?.length) {
    lines.push('## Speech patterns');
    for (const p of args.speechPatterns) lines.push(`- ${p}`);
    lines.push('');
  }
  lines.push('## Example lines');
  for (const e of args.exampleLines) lines.push(`> ${e}`);
  if (args.pokemonAssociations?.length) {
    lines.push('');
    lines.push('## Pokémon associations');
    for (const p of args.pokemonAssociations) lines.push(`- ${p}`);
  }
  lines.push('');
  lines.push('---');
  lines.push(`Voice cards are read by the agent before generating any dialogue line for ${args.name}. Tools that produce dialogue (propose_generate_dialogue, propose_cutscene, propose_author_scene) honor this card automatically.`);
  const markdown = lines.join('\n');

  let persistedPath: string | null = null;
  try {
    const voicesDir = path.join(ctx.projectRoot, '.editor', 'voices');
    await fsp.mkdir(voicesDir, { recursive: true });
    const file = path.join(voicesDir, `${args.characterId}.md`);
    await fsp.writeFile(file, markdown, 'utf8');
    persistedPath = file;
  } catch {
    /* best-effort */
  }

  return {
    ok: true,
    persistedPath,
    markdown,
    message:
      `Voice card for ${args.name} (id ${args.characterId}) persisted` +
      (persistedPath ? ` to ${persistedPath}` : ' in-memory only (write failed)') +
      '. Future dialogue generation will honor this voice.',
  };
}
