export interface ResponseRepairTransaction {
  status: 'success' | 'failed';
  ticketId: string;
  agentId: string;
}
