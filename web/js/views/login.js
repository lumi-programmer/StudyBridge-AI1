// Sign in for production hosting. Only reachable when config.js points at a
// Supabase project; without it the platform signs students in itself and this
// view explains that instead of showing a dead form.
import { h, clear, field, pageHead } from '../ui.js';
import { configured, forgetSession, sessionEmail, signIn, signUp,
  requestPasswordReset, consumeRecovery, updatePassword } from '../auth.js';

const PASSWORD_MIN = 8;

// minlength is a rule for NEW passwords only: an existing account may have any
// password, and a native minimum on the sign-in field would block its owner
// from submitting the form at all.
function passwordInput(autocomplete, forNewPassword = false) {
  const props = { type: 'password', autocomplete, required: true };
  if (forNewPassword) props.minlength = String(PASSWORD_MIN);
  return h('input', props);
}

// Auth failures speak for themselves — no "this section could not load" shell
// copy, and the fix for the situation sits right in the banner as a button.
function authNotice(error, actions = []) {
  return h('div', { class: 'banner bad' },
    h('div', {},
      h('span', { text: error?.message || 'Sign-in failed. Please try again.' }),
      actions.length ? h('div', { class: 'row wrap-gap', style: { marginTop: '10px' } }, actions) : null));
}

export async function render(root, { navigate }) {
  if (!configured) {
    clear(root).appendChild(h('div', { class: 'stack' },
      pageHead('Account', 'Sign in', 'This server signs students in itself — nothing to fill in here.'),
      h('section', { class: 'card stack' },
        h('p', { text: 'You are already signed in through the platform. Head back to your dashboard.' }),
        h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/dashboard', text: 'Go to Dashboard' })))));
    return null;
  }

  const returnTo = () => {
    let saved = null;
    try { saved = sessionStorage.getItem('studybridge.return_path'); sessionStorage.removeItem('studybridge.return_path'); } catch { saved = null; }
    navigate(saved && saved.includes('#') ? saved.slice(saved.indexOf('#')) : '#/dashboard');
  };

  const wrap = h('div', { class: 'stack' });
  clear(root).appendChild(wrap);

  function signedInCard(email) {
    clear(wrap).append(
      pageHead('Account', 'You are signed in', email || ''),
      h('section', { class: 'card stack' },
        h('p', { text: `Signed in as ${email || 'a student account'}. Continue to your dashboard or sign out of this browser.` }),
        h('div', { class: 'row' },
          h('a', { class: 'btn', href: '#/dashboard', text: 'Go to Dashboard' }),
          h('button', { class: 'btn secondary', type: 'button', text: 'Sign out', onClick: async () => {
            await signOutWrapper();
            drawIntro();
          } }))));
  }

  async function signOutWrapper() {
    await import('../auth.js').then(module => module.signOut());
  }

  function drawIntro(notice = null) {
    const existing = sessionEmail();
    if (existing) { signedInCard(existing); return; }
    let mode = 'signin';
    const email = h('input', { type: 'email', autocomplete: 'email', required: true, placeholder: 'you@example.com' });
    const password = passwordInput('current-password');
    const submit = h('button', { class: 'btn', type: 'submit', text: 'Sign in' });
    const forgot = h('button', { class: 'link-btn', type: 'button', text: 'Forgot your password?', onClick: () => drawForgot() });
    function setMode(next) {
      mode = next;
      password.setAttribute('autocomplete', mode === 'signup' ? 'new-password' : 'current-password');
      if (mode === 'signup') password.setAttribute('minlength', String(PASSWORD_MIN));
      else password.removeAttribute('minlength');
      submit.textContent = mode === 'signup' ? 'Create account' : 'Sign in';
      toggle.textContent = mode === 'signup' ? 'I already have an account' : 'Create an account instead';
      forgot.hidden = mode === 'signup';
      noticeBox.replaceChildren();
    }
    const toggle = h('button', { class: 'btn secondary', type: 'button', text: 'Create an account instead', onClick: () => setMode(mode === 'signin' ? 'signup' : 'signin') });
    const noticeBox = h('div', {});
    const form = h('form', { class: 'card stack', onSubmit: async event => {
      event.preventDefault();
      submit.disabled = true;
      noticeBox.replaceChildren();
      try {
        const result = mode === 'signin'
          ? await signIn(email.value.trim(), password.value)
          : await signUp(email.value.trim(), password.value);
        if (result.confirmation_required) {
          noticeBox.replaceChildren(h('div', { class: 'banner good' },
            h('b', { text: 'Check your email' }),
            h('span', { text: ' Confirm the address, then sign in here.' })));
        } else {
          returnTo();
        }
      } catch (error) {
        const actions = [];
        if (error.code === 'user_already_exists') {
          actions.push(h('button', { class: 'btn sm', type: 'button', text: 'Switch to sign in', onClick: () => {
            setMode('signin');
            password.focus();
          } }));
        } else if (error.code === 'invalid_credentials' || error.code === 'invalid_grant') {
          actions.push(h('button', { class: 'btn sm secondary', type: 'button', text: 'Create a new account instead', onClick: () => {
            setMode('signup');
            password.focus();
          } }));
        }
        noticeBox.replaceChildren(authNotice(error, actions));
      } finally {
        submit.disabled = false;
      }
    } },
      notice,
      noticeBox,
      field('Email', email),
      field('Password', password, 'At least 8 characters.'),
      h('div', { class: 'row end' }, submit, toggle),
      h('div', { class: 'row end' }, forgot));
    clear(wrap).append(
      pageHead('Account', 'Sign in', 'Your spaces, books and Bridge Credits are waiting ✨.'),
      form);
  }

  function drawForgot() {
    const email = h('input', { type: 'email', autocomplete: 'email', required: true, placeholder: 'you@example.com' });
    const submit = h('button', { class: 'btn', type: 'submit', text: 'Send reset link' });
    const noticeBox = h('div', {});
    const form = h('form', { class: 'card stack', onSubmit: async event => {
      event.preventDefault();
      submit.disabled = true;
      noticeBox.replaceChildren();
      try {
        await requestPasswordReset(email.value.trim());
        // Same reply whether or not the address has an account, so the form
        // cannot be used to discover who is registered.
        clear(wrap).append(
          pageHead('Account', 'Check your email',
            'If an account exists for that address, a link to choose a new password is on its way.'),
          h('section', { class: 'card stack' },
            h('p', { text: 'The link opens StudyBridge and lets you set a new password. It expires shortly — request another if it lapses.' }),
            h('div', { class: 'row' },
              h('button', { class: 'btn secondary', type: 'button', text: 'Back to sign in', onClick: () => drawIntro() }))));
      } catch (error) {
        submit.disabled = false;
        noticeBox.replaceChildren(authNotice(error));
      }
    } },
      noticeBox,
      field('Email', email),
      h('div', { class: 'row end' }, submit),
      h('div', { class: 'row end' },
        h('button', { class: 'link-btn', type: 'button', text: 'Back to sign in', onClick: () => drawIntro() })));
    clear(wrap).append(
      pageHead('Account', 'Reset password', 'Enter the email you signed up with and we will send a reset link.'),
      form);
    email.focus();
  }

  function drawReset() {
    const password = passwordInput('new-password', true);
    const confirm = passwordInput('new-password', true);
    const submit = h('button', { class: 'btn', type: 'submit', text: 'Set new password' });
    const noticeBox = h('div', {});
    const form = h('form', { class: 'card stack', onSubmit: async event => {
      event.preventDefault();
      noticeBox.replaceChildren();
      if (password.value !== confirm.value) {
        noticeBox.replaceChildren(authNotice({ message: 'The two passwords do not match.' }));
        return;
      }
      submit.disabled = true;
      try {
        await updatePassword(password.value);
        clear(wrap).append(
          pageHead('Account', 'Password updated', 'Your new password is active from now on.'),
          h('section', { class: 'card stack' },
            h('div', { class: 'row' },
              h('button', { class: 'btn', type: 'button', text: 'Continue', onClick: () => returnTo() }))));
      } catch (error) {
        noticeBox.replaceChildren(authNotice(error));
        submit.disabled = false;
      }
    } },
      noticeBox,
      field('New password', password, 'At least 8 characters.'),
      field('Repeat new password', confirm),
      h('div', { class: 'row end' }, submit));
    clear(wrap).append(
      pageHead('Account', 'Choose a new password',
        'This link opened a one-time session — it is already used up once you set the password.'),
      form);
    password.focus();
  }

  // app.js adopts the recovery fragment before routing here and hands the
  // outcome over: a fresh one-time session means "choose a new password".
  const recovery = consumeRecovery();
  if (recovery.kind === 'recovery') drawReset();
  else if (recovery.kind === 'error') drawIntro(h('div', { class: 'banner bad' }, h('span', { text: recovery.message })));
  else drawIntro();
  return null;
}
