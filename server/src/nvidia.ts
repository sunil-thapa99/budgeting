import OpenAI from 'openai';
import 'dotenv/config';

// NVIDIA build API is OpenAI-compatible — same SDK, different baseURL + key.
export const nvidia = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY || '',
  baseURL: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
  timeout: 60_000,   // fail fast instead of hanging the request
  maxRetries: 1,
});

export const INSIGHTS_MODEL = process.env.INSIGHTS_MODEL || 'meta/llama-3.3-70b-instruct';
export const VISION_MODEL = process.env.VISION_MODEL || 'meta/llama-3.2-90b-vision-instruct';
// Small/fast model for bulk transaction categorization (easy task, high volume).
export const CATEGORIZE_MODEL = process.env.CATEGORIZE_MODEL || 'meta/llama-3.1-8b-instruct';

export function assertKey() {
  if (!process.env.NVIDIA_API_KEY) {
    const e: any = new Error('NVIDIA_API_KEY is not set in server/.env');
    e.status = 503;
    throw e;
  }
}
