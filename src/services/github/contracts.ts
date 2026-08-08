export interface NormalizedGitHubEvent {
  deliveryId: string;
  eventName: string;
  action: string | null;
  repository: string;
  correlationKey: string;
  issueNumber: number | null;
  senderLogin: string | null;
  isHumanComment: boolean;
  commentBody: string | null;
  requiresHuman: boolean;
  payload: unknown;
}
