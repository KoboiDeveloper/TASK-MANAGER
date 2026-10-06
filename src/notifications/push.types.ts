export type PushCategory =
  | 'pushChat'
  | 'pushTask'
  | 'pushProject'
  | 'pushTicket'
  | 'pushDigest'
  | 'pushAccount';

export type PushPayload = {
  type: string;
  title: string;
  body: string;
  url?: string;
  tag?: string;
  data?: Record<string, unknown>;
};

/** Map event type → preference category */
export const PUSH_TYPE_CATEGORY: Record<string, PushCategory> = {
  'chat.dm_message': 'pushChat',
  'chat.group_message': 'pushChat',
  'chat.reply': 'pushChat',
  'chat.added_to_group': 'pushChat',
  'chat.new_dm': 'pushChat',
  'chat.task_shared': 'pushChat',
  'chat.reaction': 'pushChat',

  'task.assigned': 'pushTask',
  'task.subtask_assigned': 'pushTask',
  'task.due_date_changed': 'pushTask',
  'task.due_tomorrow': 'pushTask',
  'task.due_today': 'pushTask',
  'task.overdue': 'pushTask',
  'task.completed': 'pushTask',
  'project.completed': 'pushTask',
  'task.attachment': 'pushTask',
  'task.removed': 'pushTask',

  'project.member_added': 'pushProject',
  'project.role_changed': 'pushProject',
  'project.access_revoked': 'pushProject',
  'project.archived': 'pushProject',

  'ticket.assigned': 'pushTicket',
  'ticket.reassigned': 'pushTicket',
  'ticket.on_process': 'pushTicket',
  'ticket.completed': 'pushTicket',
  'ticket.pending': 'pushTicket',
  'ticket.cancelled': 'pushTicket',
  'ticket.failed': 'pushTicket',

  'digest.morning': 'pushDigest',

  'account.password_changed': 'pushAccount',
  'account.new_device_login': 'pushAccount',
  'account.deactivated': 'pushAccount',
  'account.role_changed': 'pushAccount',
};

export function checkNotificationPref(
  prefsJson: string | null | undefined,
  key: string,
): boolean {
  if (!prefsJson) return true;
  try {
    const prefs = JSON.parse(prefsJson) as Record<string, unknown>;
    if (prefs[key] === false) return false;
    return true;
  } catch {
    return true;
  }
}

export function isPushAllowed(
  prefsJson: string | null | undefined,
  type: string,
): boolean {
  if (!checkNotificationPref(prefsJson, 'pushEnabled')) return false;
  const cat = PUSH_TYPE_CATEGORY[type];
  if (!cat) return true;
  return checkNotificationPref(prefsJson, cat);
}
