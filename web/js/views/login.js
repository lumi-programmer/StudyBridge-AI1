// Sign in for production hosting. Only reachable when config.js points at a
// Supabase project; without it the platform signs students in itself and this
// view explains that instead of showing a dead form.
import { h, clear, field, pageHead, errorCard } from '../ui.js';
import { configured, forgetSession, sessionEmail, signIn, signUp,
  requestPasswordReset, consumeRecovery, updatePassword } from '../auth.js';

const PASSWORD_MIN = 8;

function passwordInput(autocomplete) {
  return h('input', { type: 'password', autocomplete, minlength: String(PASSWORD_MIN), required: true });
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
    const toggle = h('button', { class: 'btn secondary', type: 'button', text: 'Create an account instead', onClick: () => {
      mode = mode === 'signin' ? 'signup' : 'signin';
      password.setAttribute('autocomplete', mode === 'signup' ? 'new-password' : 'current-password');
      submit.textContent = mode === 'signup' ? 'Create account' : 'Sign in';
      toggle.textContent = mode === 'signup' ? 'I already have an account' : 'Create an account instead';
      forgot.hidden = mode === 'signup';
      noticeBox.replaceChildren();
    } });
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
        noticeBox.replaceChildren(errorCard(error));
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
      pageHead('Account', 'Sign in', 'Your spaces, books and Bridge Credits are waiting.'),
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
        noticeBox.replaceChildren(errorCard(error, () => {
          submit.disabled = false;
          noticeBox.replaceChildren();
        }));
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
    const password = passwordInput('new-password');
    const confirm = passwordInput('new-password');
    const submit = h('button', { class: 'btn', type: 'submit', text: 'Set new password' });
    const noticeBox = h('div', {});
    const form = h('form', { class: 'card stack', onSubmit: async event => {
      event.preventDefault();
      noticeBox.replaceChildren();
      if (password.value !== confirm.value) {
        noticeBox.replaceChildren(errorCard({ message: 'The two passwords do not match.' }));
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
        noticeBox.replaceChildren(errorCard(error));
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
  else if (recovery.kind === 'error') drawIntro(errorCard({ message: recovery.message }));
  else drawIntro();
  return null;
}
