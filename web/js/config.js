// Deploy-time configuration for production hosting. Fill in the two values
// when deploying: the Supabase project URL and its PUBLIC anon key (the anon
// key is designed to be public; the service-role key must never be placed
// here or anywhere in the browser). Leave empty for local development — the
// auth layer stays dormant and the preview keeps its signed-in stub user.
window.__STUDYBRIDGE_CONFIG__ = {
  supabaseUrl: '',
  supabaseAnonKey: '',
};
