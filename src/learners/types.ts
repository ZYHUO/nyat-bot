export interface ExpressionEntry {
  id: number;
  chat_id: number;
  situation: string;
  style: string;
  count: number;
  source_msg_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface JargonEntry {
  id: number;
  chat_id: number;
  content: string;
  raw_samples: string;
  meaning: string;
  count: number;
  status: 'pending' | 'inferred' | 'confirmed';
  created_at: number;
  updated_at: number;
}

export interface LearnedExpression {
  situation: string;
  style: string;
  source_id?: string;
}

export interface LearnedJargon {
  content: string;
  source_id?: string;
  /** B:领域标签(infra/meme/general…),供按域选择性注入 */
  domain?: string;
}

export interface LearnerScanResult {
  expressions: LearnedExpression[];
  jargons: LearnedJargon[];
}

export interface JargonInferResult {
  meaning: string;
  no_info: boolean;
}
