import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { InviteConnectedView, InviteFlowView } from '@meegrow-social/contracts';
import { api, ApiError } from '../lib/api';
import { PRODUCT_NAME, signInName } from '../lib/platforms';
import { missingAccountHelp } from '../lib/connectHelp';
import { InviteCard, InviteHeading, recallInviteToken, rememberInviteToken } from './Invite';

/**
 * A dead step, worded by what the client should do next. The invite link stays usable until an
 * account has been connected through it — so every retry here points back at the link, except the
 * one case where it has done its job.
 */
function stopped(err: unknown): { title: string; detail: string } {
  const status = err instanceof ApiError ? err.status : 0;
  if (status === 410) {
    return {
      title: 'This took too long',
      detail:
        'The connection step expired or the link was cancelled before it was finished, so nothing was connected. Open the link your agency sent you and try again. If the link no longer works, ask them for a fresh one.',
    };
  }
  if (status === 409) {
    return {
      title: 'This step is already finished',
      detail:
        'An account was already connected with this link, so the link has stopped working. To connect another account, ask your agency for a new link.',
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

/**
 * What to do when the account they want was not offered (or nothing was): the real causes with the
 * step for each, and a way to start the same invite again. The fix is made on the platform's own
 * screens — nothing on our side can re-open its list.
 */
function MissingAccountHelp({ flow }: { flow: InviteFlowView }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const token = recallInviteToken();
  const signIn = signInName(flow);
  const help = missingAccountHelp(flow, 'client');

  const retry = async () => {
    if (!token) return;
    setBusy(true);
    setErr(null);
    try {
      const { url } = await api.startInvite(token);
      rememberInviteToken(token);
      window.location.href = url;
    } catch {
      setErr('Could not start again — the link may have expired. Ask your agency for a fresh one.');
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 rounded-sm bg-surface-soft p-4 text-sm text-body-ink">
      {help.causes.length > 0 ? (
        <ol className="list-decimal space-y-2.5 pl-5">
          {help.causes.map((c) => (
            <li key={c.cause}>
              <b className="text-ink">{c.cause}</b> {c.fix}
            </li>
          ))}
        </ol>
      ) : (
        <p>
          Start again and, on {signIn}’s screens, make sure the account you want is selected before
          you approve.
        </p>
      )}
      {err && <p className="mt-3 text-error">{err}</p>}
      {token ? (
        <button
          onClick={() => void retry()}
          disabled={busy}
          className="mt-4 inline-flex h-10 w-full items-center justify-center rounded-sm border border-ink bg-canvas px-4 text-sm font-medium text-ink hover:bg-surface-strong disabled:opacity-60"
        >
          {busy ? 'Redirecting…' : `Try again with ${signIn}`}
        </button>
      ) : (
        <p className="mt-3 text-muted">
          To start again, open the link your agency sent you once more.
        </p>
      )}
    </div>
  );
}

type State =
  | { step: 'loading' }
  | {
      step: 'pick';
      flow: InviteFlowView;
      busy: string | null;
      error: string | null;
      help: boolean;
    }
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
        setState({
          step: 'pick',
          flow: await api.getInviteFlow(flowId),
          busy: null,
          error: null,
          help: false,
        });
      } catch (e) {
        setState({ step: 'stopped', ...stopped(e) });
      }
    })();
  }, [flowId]);

  const connect = async (flow: InviteFlowView, externalId: string) => {
    setState({ step: 'pick', flow, busy: externalId, error: null, help: false });
    try {
      setState({ step: 'connected', result: await api.finishInviteFlow(flowId, externalId) });
    } catch (e) {
      // The flow survives a refused account (400) and a platform failure (502): let them retry.
      if (e instanceof ApiError && (e.status === 400 || e.status === 502)) {
        setState({
          step: 'pick',
          flow,
          busy: null,
          help: false,
          error: `That account could not be connected: ${e.message}. Nothing was connected.`,
        });
      } else {
        setState({ step: 'stopped', ...stopped(e) });
      }
    }
  };

  return (
    <InviteCard>
      {/* The same words as the static shell in index.html, which shows while this bundle loads. */}
      {state.step === 'loading' && <p className="text-muted">Finishing up…</p>}

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
            {state.result.providerDisplayName}) is now connected. The team that manages social media
            for <b className="text-ink">{state.result.workspaceName}</b> can publish to it and read
            its insights through {PRODUCT_NAME}. You can close this window.
          </p>
        </>
      )}

      {state.step === 'pick' && state.flow.accounts.length === 0 && (
        <>
          <InviteHeading
            provider={state.flow.provider}
            title="Nothing to connect yet"
            subtitle={`Nothing was connected for ${state.flow.workspaceName}`}
          />
          <p className="text-sm text-body-ink">{missingAccountHelp(state.flow, 'client').lead}</p>
          <MissingAccountHelp flow={state.flow} />
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
            subtitle={`One more step for ${state.flow.workspaceName} — nothing is connected yet`}
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
            The team that manages social media for {state.flow.workspaceName} will be able to
            publish to the account you connect and read its insights, through {PRODUCT_NAME}.
          </p>
          {state.help ? (
            <MissingAccountHelp flow={state.flow} />
          ) : (
            <button
              onClick={() => setState({ ...state, help: true })}
              className="mt-3 text-sm font-medium text-ink underline underline-offset-2"
            >
              The one I want isn’t listed
            </button>
          )}
        </>
      )}
    </InviteCard>
  );
}
