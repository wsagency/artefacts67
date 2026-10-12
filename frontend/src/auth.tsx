import { createSignal, onSettled, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { Panel, Field, PostForm, Button, Feedback, LinkButton, CopyValue, postJSON } from './ui';
import { navigate, refreshPage } from './navigation';
import type { PageProps } from './types';

const encode = (buffer: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = (value: string): ArrayBuffer => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0)).buffer;

type CredentialDescriptorPayload = { id: string | ArrayBuffer; type?: PublicKeyCredentialType; transports?: AuthenticatorTransport[] };
type PublicKeyOptionsPayload = {
  challenge: string | ArrayBuffer;
  user?: { id: string | ArrayBuffer; name?: string; displayName?: string };
  excludeCredentials?: CredentialDescriptorPayload[];
  allowCredentials?: CredentialDescriptorPayload[];
  [key: string]: unknown;
};

/** A passkey ceremony: enrolment, the second factor, or (login) passkey-first sign-in (ADR 0034). */
export function Passkey(props: { csrf?: string; enroll?: boolean; login?: boolean }) {
  const [name, setName] = createSignal('Passkey');
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const base = props.enroll ? '/settings/passkeys' : props.login ? '/passkey/login' : '/passkey';
  // Passkey-first also offers passkeys in the email field's autofill, through the same endpoints.
  let autofill: AbortController | undefined;
  async function run(conditional = false): Promise<void> {
    autofill?.abort(); // a browser runs one WebAuthn request at a time
    autofill = conditional ? new AbortController() : undefined;
    const signal = autofill?.signal;
    if (!conditional) { setBusy(true); setError(''); } // a re-armed autofill keeps the last message
    let picked = false; // autofill errors before the user picks a passkey stay silent
    try {
      if (!window.PublicKeyCredential) throw new Error(`This browser does not support passkeys. ${props.login ? 'Sign in with email and password.' : 'Use your authenticator code.'}`);
      const result = await postJSON(`${base}/begin`, { csrf: props.csrf ?? '' });
      const token = typeof result.token === 'string' ? result.token : '';
      const options = result.options as PublicKeyOptionsPayload;
      if (typeof options.challenge !== 'string') throw new Error('The passkey challenge is invalid.');
      options.challenge = decode(options.challenge);
      if (props.enroll && options.user) {
        if (typeof options.user.id !== 'string') throw new Error('The passkey user identifier is invalid.');
        options.user.id = decode(options.user.id);
      }
      for (const credential of options[props.enroll ? 'excludeCredentials' : 'allowCredentials'] as CredentialDescriptorPayload[] | undefined ?? []) {
        if (typeof credential.id !== 'string') throw new Error('The passkey credential identifier is invalid.');
        credential.id = decode(credential.id);
      }
      const publicKey = options as unknown as PublicKeyCredentialCreationOptions;
      if (!props.enroll) {
        const assertionOptions = options as unknown as PublicKeyCredentialRequestOptions;
        const credential = await navigator.credentials.get(signal ? { publicKey: assertionOptions, mediation: 'conditional', signal } : { publicKey: assertionOptions });
        if (!(credential instanceof PublicKeyCredential)) throw new Error('No credential was returned.');
        picked = true;
        const response = credential.response as AuthenticatorAssertionResponse;
        // A discoverable credential returns its userHandle; passkey-first identifies the account by it.
        await postJSON(`${base}/complete`, { csrf: props.csrf ?? '', token, credential: { id: credential.id, rawId: encode(credential.rawId), type: credential.type, response: { clientDataJSON: encode(response.clientDataJSON), authenticatorData: encode(response.authenticatorData), signature: encode(response.signature), ...(response.userHandle ? { userHandle: encode(response.userHandle) } : {}) } } });
      } else {
        const credential = await navigator.credentials.create({ publicKey });
        if (!(credential instanceof PublicKeyCredential)) throw new Error('No credential was returned.');
        const response = credential.response as AuthenticatorAttestationResponse;
        await postJSON(`${base}/complete`, { csrf: props.csrf ?? '', token, name: name(), credential: { id: credential.id, rawId: encode(credential.rawId), type: credential.type, response: { clientDataJSON: encode(response.clientDataJSON), attestationObject: encode(response.attestationObject) } } });
      }
      if (props.enroll) { setBusy(false); await refreshPage(); } else { setBusy(false); await navigate('/app'); }
    } catch (cause) {
      const errorName = cause instanceof DOMException ? cause.name : '';
      if (conditional && !picked) return; // begin failure, abort or dismissal: autofill was never used
      if (conditional && cause instanceof Error && 'code' in cause && cause.code === 'webauthn-pending') {
        setError('The sign-in request expired. Please try again.');
        void run(true);
        return;
      }
      setBusy(false);
      setError(errorName === 'NotAllowedError' ? 'The passkey operation was cancelled. Please try again.' : cause instanceof Error ? cause.message : 'The passkey operation failed.');
    }
  }
  if (props.login) onSettled(() => {
    void window.PublicKeyCredential?.isConditionalMediationAvailable?.().then(available => { if (available) void run(true); });
    return () => autofill?.abort();
  });
  return <div class="stack"><Feedback error={error()} />{props.enroll && <Field label="Passkey name" value={name()} onChange={setName} maxlength={64} />}<Button variant={props.login ? 'primary' : 'secondary'} disabled={busy()} onClick={() => { void run(); }}>{busy() ? 'Waiting for your device…' : props.enroll ? 'Add a passkey' : 'Sign in with a passkey'}</Button></div>;
}

const Passwords = (): JSX.Element => <><Field label="Password (at least 8 characters)" name="password" type="password" minlength={8} autocomplete="new-password" required /><Field label="Confirm password" name="confirm" type="password" minlength={8} autocomplete="new-password" required /></>;
const Code = (): JSX.Element => <Field label="Authenticator code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength={6} autocomplete="one-time-code" required autofocus />;

export function AuthScreen(props: { screen: string; p: PageProps }) {
  const screen = untrack(() => props.screen);
  const p = untrack(() => props.p);
  const values = untrack(() => p.values ?? {});
  let title: string | undefined;
  let content: JSX.Element;
  switch (screen) {
    case 'home': title = 'Private artefacts. Shared with purpose.'; content = <><p>Self-contained reports, credentials and handovers, private by default. Only signed-in, authorized colleagues can open them; external readers get a named share link you can expire or revoke. Nothing is publicly listed or searchable.</p><LinkButton href={p.bootstrap ? '/register' : '/login'}>{p.bootstrap ? 'Set up the owner account' : 'Sign in'}</LinkButton><a href="/instructions">Explore all features & instructions</a></>; break;
    case 'login': title = 'Sign in'; content = <><p class="muted">Only invited users can sign in.</p><Passkey login /><p class="muted">or sign in with email and password</p><PostForm action="/login" submit={false}><Field label="Email" name="email" type="email" value={p.email} autocomplete="username webauthn" required /><Field label="Password" name="password" type="password" autocomplete="current-password" required /><Button type="submit" variant="secondary">Sign in with password</Button></PostForm></>; break;
    case 'register': title = 'Set up the owner'; content = <><p>This first account becomes the platform owner and can invite others.</p><PostForm action="/register" submit="Create account"><Field label="Name" name="name" value={values.name} autocomplete="name" required /><Field label="Email" name="email" type="email" value={values.email} autocomplete="username" required /><Passwords /></PostForm></>; break;
    case 'accept': title = 'Join the platform'; content = <><p>{p.invite?.inviterName ? `${p.invite.inviterName} invited you to Artefacts67.` : 'You have been invited to Artefacts67.'}</p><PostForm action={`/invite/${encodeURIComponent(p.invite?.token ?? '')}`} submit="Activate account"><Field label="Email" name="email" type="email" value={p.invite?.email ?? values.email} readonly /><Field label="Name" name="name" value={values.name} autocomplete="name" required /><Passwords /></PostForm></>; break;
    case 'twoFa': title = 'Verify your sign-in'; content = <><p>Enter the current six-digit code from your authenticator app.</p><PostForm action="/2fa" csrf={p.csrf} submit="Verify"><Code /></PostForm>{p.hasPasskey && <Passkey csrf={p.csrf ?? ''} />}</>; break;
    case 'enroll': title = 'Set up an authenticator'; content = <><p>{p.intro || 'Add this account in your authenticator app, then verify a live code.'}</p><CopyValue label="Copy setup secret" value={String(p.secret ?? '').replace(/(.{4})/g, '$1 ').trim()} /><CopyValue label="Copy otpauth URI" value={p.otpauth ?? ''} /><PostForm action="/enroll" csrf={p.csrf} submit="Verify and finish"><Code /></PostForm></>; break;
    default: title = p.title; content = <>{p.sub && <p>{p.sub}</p>}<div innerHTML={p.body ?? p.main ?? ''} /></>;
  }
  const product = '/assets/ws-design-kit/products/artefacts67/original';
  const sign = '/assets/ws-design-kit/logos/original';
  const operator = String(p.operator ?? '').trim();
  // Spec §D3–§D5: kit scope on <main> (not <html>, which would darken the console's controls), product logo above the panel, attribution below it.
  return <main class="auth-page wsa-brand" data-identity="original" data-appearance="auto">
    <a class="auth-brand" href="/"><picture><source media="(prefers-color-scheme: dark)" srcset={`${product}/logo-white.svg`} /><img src={`${product}/logo-color.svg`} alt="Artefacts67" width="260" style="max-width:100%;height:auto" /></picture></a>
    <Panel title={title}><Feedback error={p.error} notice={p.notice} /><div class="stack">{content}</div></Panel>
    <footer class="auth-foot">
      <a class="wsa-brand wsa-credit" data-identity="original" data-appearance="auto" href="https://ws.agency/" aria-label="Made with love by WS Agency"><span>Made with <span class="sr-only">love</span></span><span class="wsa-credit-symbols"><svg class="wsa-heart" width="20.48" height="20" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0.67 0.17 22.66 22.13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"><path d="M12 21C10 19 2 13 2 7a5 5 0 0 1 10-1 5 5 0 0 1 10 1c0 6-8 12-10 14Z" /></svg><span>by</span><img class="wsa-on-light" src={`${sign}/sign-color.svg`} alt="" /><img class="wsa-on-dark" src={`${sign}/sign-white.svg`} alt="" /></span></a>
      {p.source && <p><a href={p.source}>Source code (MIT)</a></p>}
      {operator && <p>Hosted by {operator}</p>}
      <p><a href="/instructions">Documentation</a></p>
    </footer>
  </main>;
}
