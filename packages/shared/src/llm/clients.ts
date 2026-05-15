import Anthropic from '@anthropic-ai/sdk';
import { execFile } from 'child_process';

type LLMProvider = 'claude-cli' | 'anthropic';

function getProvider(): LLMProvider {
  return (process.env.LLM_PROVIDER as LLMProvider) || 'claude-cli';
}

export function isDevMode(): boolean {
  return process.env.NODE_ENV !== 'production';
}

// ── Anthropic (Claude API) ──
let _anthropicClient: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!_anthropicClient) {
    _anthropicClient = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }
  return _anthropicClient;
}

// ── Claude CLI (subprocess) ──
function callClaudeCli(prompt: string, system?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const fullPrompt = system ? `${system}\n\n${prompt}` : prompt;
    const claudePath = process.env.CLAUDE_CLI_PATH || 'claude';

    const child = execFile(claudePath, [
      '-p', fullPrompt,
      '--output-format', 'text',
      '--dangerously-skip-permissions',
      '--model', 'claude-sonnet-4-6',
    ], {
      maxBuffer: 1024 * 1024,
      timeout: 120000,
      env: { ...process.env },
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Claude CLI failed: ${error.message}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

// ── Unified LLM call ──

export async function llmChat(prompt: string, options?: {
  system?: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}): Promise<string> {
  const { system, temperature = 0.1, maxTokens = 500, jsonMode = false } = options || {};
  const provider = getProvider();

  if (provider === 'claude-cli') {
    const jsonInstruction = jsonMode ? '\n\nRespond with ONLY valid JSON. No markdown, no code blocks, no explanation.' : '';
    const result = await callClaudeCli(prompt + jsonInstruction, system);

    // Strip markdown code blocks if present
    const codeBlockMatch = result.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) return codeBlockMatch[1].trim();
    return result;
  }

  // anthropic
  const res = await getAnthropicClient().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: system ? `${system}\n\n${prompt}` : prompt }],
    ...(temperature !== undefined ? { temperature } : {}),
  });

  return (res.content[0] as any).text.trim();
}

export async function llmChatWithRetry(prompt: string, options?: {
  system?: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  retries?: number;
}): Promise<string> {
  const { retries = 3, ...rest } = options || {};
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await llmChat(prompt, rest);
    } catch (err: any) {
      if (attempt < retries - 1) {
        const waitSec = 5 * (attempt + 1);
        console.log(`    LLM error — waiting ${waitSec}s before retry ${attempt + 2}/${retries}...`);
        await sleep(waitSec * 1000);
        continue;
      }
      throw err;
    }
  }
  return '';
}
