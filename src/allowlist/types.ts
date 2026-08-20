export interface GroupRecord {
  chat_id: number;
  approved: boolean;
  enabled: boolean;
  approved_by: string;
  approved_at: number;
  title: string;
  last_request_id: string;
  submitter_user_id: number;
  submitter_username?: string;
  submitter_first_name?: string;
  submitter_last_name?: string;
  review_state: 'manual_approved' | 'auto_approved';
  ai_decision?: 'APPROVE' | 'REJECT';
  ai_confidence?: number;
  ai_reason: string;
  ai_reviewed_at?: number;
  updated_at: number;
}

export interface PendingRequest {
  request_id: string;
  chat_id: number;
  user_id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  note: string;
  chat_title: string;
  created_at: number;
  ai_decision?: 'APPROVE' | 'REJECT';
  ai_confidence?: number;
  ai_reason: string;
  ai_reviewed_at?: number;
  review_state: 'needs_manual' | 'auto_approved';
  /** 申请来源：miniapp（旧入口）/ dm（私聊 bot 申请）/ join（bot 入群自动审核）。 */
  source?: 'miniapp' | 'dm' | 'join';
  /** 申请人在目标群的成员身份（bot 在群里能查到时回填）。 */
  applicant_member_status?: string;
}

export interface AllowlistConfig {
  enabled: boolean;
  redisPrefix: string;
  defaultEnabledAfterApproval: boolean;
  maxSubmissionsPerUserPerDay: number;
  autoAiReviewOnSubmit: boolean;
  autoAiReviewMessageLimit: number;
  aiReviewContextMaxChars: number;
  aiApproveAutoEnable: boolean;
  aiApproveConfidenceThreshold: number;
}

export interface AiReviewResult {
  decision: 'APPROVE' | 'REJECT';
  confidence: number;
  reason: string;
}

export interface SubmitResult {
  ok: boolean;
  request_id?: string;
  error?: string;
}

export interface SubmitParams {
  chatId: number;
  userId: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  note: string;
  chatTitle: string;
}
