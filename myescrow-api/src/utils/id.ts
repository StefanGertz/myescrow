const pad = (value: number, size = 4) => value.toString().padStart(size, "0");

export function buildEscrowReference(sequence: number) {
  return `PO-${pad(sequence)}`;
}

export function buildDisputeReference(sequence: number) {
  return `DSP-${pad(sequence)}`;
}

export function buildNotificationId(sequence: number) {
  return `notif-${pad(sequence, 2)}`;
}

export function buildTimelineId(sequence: number) {
  return `tl-${sequence}`;
}

export function buildUserId(sequence: number) {
  return `usr_${sequence}`;
}
