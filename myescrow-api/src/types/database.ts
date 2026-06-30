export type EscrowStatus = "success" | "warning";
export type TimelineStatus = "released" | "attention" | "funding";
export type DisputePriority = "high" | "medium" | "low";
export type DisputeStatus = "open" | "resolved";
export type WalletTransactionType = "TOPUP" | "WITHDRAW" | "RELEASE" | "FUND";

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
  buyerId?: string;
  sellerId?: string;
  creatorRole: "buyer" | "seller";
  counterpartyEmail: string;
  title: string;
  counterpart: string;
  amount: number; // cents
  stage: string;
  dueDescription: string;
  status: EscrowStatus;
  counterpartyApproved: boolean;
  lifecycleStatus: string;
  fundingStatus: string;
  category?: string;
  description?: string;
  approvedAt?: string;
  fundedAt?: string;
  rejectedAt?: string;
  cancelledAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type EscrowMilestoneRecord = {
  id: number;
  escrowId: number;
  title: string;
  description?: string;
  amount: number; // cents
  orderIndex: number;
  status: string;
  releasedAt?: string;
  rejectedAt?: string;
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
  escrowMilestones: EscrowMilestoneRecord[];
  disputes: DisputeRecord[];
  notifications: NotificationRecord[];
  timelineEvents: TimelineEventRecord[];
  walletTransactions: WalletTransactionRecord[];
};
