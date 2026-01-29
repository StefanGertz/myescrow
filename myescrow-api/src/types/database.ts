export type EscrowStatus = "success" | "warning";
export type TimelineStatus = "released" | "attention" | "funding";
export type DisputePriority = "high" | "medium" | "low";
export type DisputeStatus = "open" | "resolved";
export type WalletTransactionType = "TOPUP" | "WITHDRAW" | "RELEASE";

export type UserRecord = {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  walletBalance: number; // cents
  createdAt: string;
  updatedAt: string;
};

export type EscrowRecord = {
  id: number;
  reference: string;
  ownerId: string;
  title: string;
  counterpart: string;
  amount: number; // cents
  stage: string;
  dueDescription: string;
  status: EscrowStatus;
  counterpartyApproved: boolean;
  category?: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
};

export type DisputeRecord = {
  id: number;
  reference: string;
  ownerId: string;
  title: string;
  ownerTeam: string;
  amount: number; // cents held
  updatedLabel: string;
  priority: DisputePriority;
  status: DisputeStatus;
  workspaceLaunched: boolean;
  createdAt: string;
  updatedAt: string;
};

export type NotificationRecord = {
  id: string;
  userId: string;
  label: string;
  detail: string;
  meta: string;
  txId?: number;
  createdAt: string;
};

export type TimelineEventRecord = {
  id: string;
  userId: string;
  title: string;
  meta: string;
  timeLabel: string;
  status: TimelineStatus;
  createdAt: string;
};

export type WalletTransactionRecord = {
  id: number;
  userId: string;
  amount: number; // cents
  type: WalletTransactionType;
  createdAt: string;
};

export type MetaState = {
  nextEscrowSequence: number;
  nextDisputeSequence: number;
  nextNotificationSequence: number;
  nextTimelineSequence: number;
  nextTransactionSequence: number;
  nextUserSequence: number;
};

export type DatabaseSchema = {
  meta: MetaState;
  users: UserRecord[];
  escrows: EscrowRecord[];
  disputes: DisputeRecord[];
  notifications: NotificationRecord[];
  timelineEvents: TimelineEventRecord[];
  walletTransactions: WalletTransactionRecord[];
};
