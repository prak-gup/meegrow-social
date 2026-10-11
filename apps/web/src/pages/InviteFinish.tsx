import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { InviteConnectedView, InviteFlowView } from '@meegrow-social/contracts';
import { api, ApiError } from '../lib/api';
import { InviteCard, InviteHeading } from './Invite';

/** Why there is nothing to pick, in the client's terms — the platform returned an empty list. */
function nothingToConnect(flow: InviteFlowView): string {
  switch (flow.provider) {
    case 'instagram':
      return 'We couldn’t find an Instagram account to connect. It has to be a Business or Creator account that is linked to a Facebook Page you manage, and both that Page and the Instagram account have to be ticked on Facebook’s permission screens.';
    case 'facebook':
      return 'We couldn’t find a Facebook Page to connect. You need to manage the Page, and it has to be ticked on Facebook’s permission screens.';
    default:
      return `That ${flow.providerDisplayName} login didn’t offer any account that can be connected.`;
  }
}

/** A dead step, worded by what the client should do next. The invite link itself stays usable. */
function stopped(err: unknown): { title: string; detail: string } {
  const status = err instanceof ApiError ? err.status : 0;
  if (status === 410) {
    return {
      title: 'This took too long',
      detail:
        'The connection step expired before it was finished, so nothing was connected. Open the link your agency sent you and try again. If the link no longer works, ask them for a fresh one.',
    };
  }
  if (status === 409) {
    return {
      title: 'This step is already finished',
      detail:
        'An account was already connected from this page. If you wanted to connect another one, open the link your agency sent you again.',
    };
  }
  if (status === 404) {
    return {
      title: 'We can’t finish here',
      detail:
        'Nothing was connected. This page only works in the browser where you opened your invite link. Open the link your agency sent you again and stay in the same browser until you see a confirmation.',
    };
  }
  return {
    title: 'Something went wrong',
    detail: `Nothing was connected${err instanceof Error && err.message ? ` (${err.message})` : ''}. Open the link your agency sent you and try again.`,
  };
}

type State =
  | { step: 'loading' }
  | { step: 'pick'; flow: InviteFlowView; busy: string | null; error: string | null }
  | { step: 'connected'; result: InviteConnectedView }
  | { step: 'stopped'; title: string; detail: string };

/**
 * Public account picker for a connect invite (no login). /connect/callback sends the client here
 * after they approve on the platform, when the platform offers accounts to choose from. Nothing is
 * connected until they pick one, and "Connected" is only ever shown from the server's answer to
 * that pick.
 */
export function InviteFinish() {
  const { flowId = '' } = useParams();
  const [state, setState] = useState<State>({ step: 'loading' });

  useEffect(() => {
    void (async () => {
      try {
        setState({ step: 'pick', flow: await api.getInviteFlow(flowId), busy: null, error: null });
      } catch (e) {
        setState({ step: 'stopped', ...stopped(e) });
      }
    })();
  }, [flowId]);

  const connect = async (flow: InviteFlowView, externalId: string) => {
    setState({ step: 'pick', flow, busy: externalId, error: null });
    try {
      setState({ step: 'connected', result: await api.finishInviteFlow(flowId, externalId) });
    } catch (e) {
      // The flow survives a refused account (400) and a platform failure (502): let them retry.
      if (e instanceof ApiError && (e.status === 400 || e.status === 502)) {
        setState({
          step: 'pick',
          flow,
          busy: null,
          error: `That account could not be connected: ${e.message}. Nothing was connected.`,
        });
      } else {
        setState({ step: 'stopped', ...stopped(e) });
      }
    }
  };

  return (
    <InviteCard>
      {state.step === 'loading' && <p className="text-muted">Loading…</p>}

      {state.step === 'stopped' && (
        <>
          <h1 className="text-xl font-semibold">{state.title}</h1>
          <p className="mt-2 text-body text-muted">{state.detail}</p>
        </>
      )}

      {state.step === 'connected' && (
        <>
          <h1 className="text-xl font-semibold">Connected</h1>
          <p className="mt-2 text-body text-muted">
            <b className="text-ink">{state.result.accountName}</b> (
            {state.result.providerDisplayName}) is now connected to{' '}
            <b className="text-ink">{state.result.workspaceName}</b>. You can close this window.
          </p>
        </>
      )}

      {state.step === 'pick' && state.flow.accounts.length === 0 && (
        <>
          <InviteHeading
            provider={state.flow.provider}
            title="Nothing to connect yet"
            subtitle={`Nothing was connected to ${state.flow.workspaceName}`}
          />
          <p className="text-sm text-body-ink">{nothingToConnect(state.flow)}</p>
          <p className="mt-3 text-sm text-muted">
            Once that is sorted, open the link your agency sent you and try again.
          </p>
        </>
      )}

      {state.step === 'pick' && state.flow.accounts.length > 0 && (
        <>
          <InviteHeading
            provider={state.flow.provider}
            title={
              state.flow.accounts.length === 1
                ? 'Confirm the account to connect'
                : 'Choose the account to connect'
            }
            subtitle={`One more step — nothing is connected to ${state.flow.workspaceName} yet`}
          />
          {state.error && <p className="mb-4 text-sm text-error">{state.error}</p>}
          <ul className="space-y-2">
            {state.flow.accounts.map((a) => (
              <li
                key={a.externalId}
                className="flex items-center justify-between gap-3 rounded-sm border border-hairline px-3.5 py-3"
              >
                <p className="min-w-0 truncate font-medium">{a.displayName}</p>
                <button
                  onClick={() => void connect(state.flow, a.externalId)}
                  disabled={state.busy !== null}
                  className="inline-flex h-10 flex-none items-center justify-center rounded-sm bg-rausch px-4 text-sm font-medium text-white hover:bg-rausch-active disabled:opacity-60"
                >
                  {state.busy === a.externalId ? 'Connecting…' : 'Connect'}
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm text-muted">
            {state.flow.workspaceName} will be able to post to the account you connect and read its
            insights.
          </p>
        </>
      )}
    </InviteCard>
  );
}
