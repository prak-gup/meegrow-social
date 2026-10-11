import { useCallback, useEffect, useState } from 'react';
import type { OutstandingInviteView } from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { inviteStatusLine } from '../lib/connectHelp';
import { Button } from './ui/Button';
import { Copy } from '../lib/icons';

/**
 * A client's invite links that still work, loaded for the active client or a named one. A link
 * leaves this list when it is cancelled, expires, or connects an account.
 */
export function useInviteLinks(workspaceId?: string) {
  const [invites, setInvites] = useState<OutstandingInviteView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setInvites((await api.listInvites(workspaceId)).invites);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the invite links.');
    }
  }, [workspaceId]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const cancel = useCallback(
    async (id: string) => {
      try {
        await api.revokeInvite(id, workspaceId);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not cancel the link.');
      }
      await reload();
    },
    [reload, workspaceId],
  );

  return { invites, error, reload, cancel };
}

/** One outstanding link: the URL, where it stands, and the two things to do with it. */
export function InviteLinkRow({
  invite,
  onCancel,
}: {
  invite: OutstandingInviteView;
  onCancel: (id: string) => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="min-w-0 flex-1">
        <code className="block truncate font-mono text-xs text-ink">{invite.url}</code>
        <p className="text-caption text-muted">{inviteStatusLine(invite)}</p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          void navigator.clipboard?.writeText(invite.url).then(() => setCopied(true));
        }}
      >
        <Copy size={16} />
        {copied ? 'Copied' : 'Copy link'}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={cancelling}
        onClick={() => {
          setCancelling(true);
          void onCancel(invite.id).finally(() => setCancelling(false));
        }}
      >
        {cancelling ? 'Cancelling…' : 'Cancel link'}
      </Button>
    </div>
  );
}
