/** At most this many creatures fight on the stage at once (the rest wait on deck). */
export const MAX_ON_STAGE = 8;
export const ENTRANCE_S = 8.5;
export const GROUP_ENTRANCE_S = 5;
export const SHARE_WINDOW_S = 1.5;

export type MatchEvent =
  | { type: 'entranceStart'; ids: string[]; group: boolean }
  | { type: 'entranceEnd'; ids: string[] }
  | { type: 'knockOut'; ids: string[] }
  | { type: 'holdsStage'; id: string }
  | { type: 'lone'; id: string }
  | { type: 'tie'; ids: string[] }
  | { type: 'crowned'; id: string; others: string[] }
  | { type: 'again'; ids: string[] };
