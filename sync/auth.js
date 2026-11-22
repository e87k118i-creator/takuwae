/**
 * Takuwae v2.1.0 — isolated authentication adapter.
 * This module is intentionally NOT wired into the published app.
 *
 * Inject a Supabase client created with the PROJECT URL and PUBLISHABLE/ANON key.
 * Never put a service_role/secret key in browser code.
 * No localStorage 'takuwae-v1' reads/writes, no financial data uploads.
 */
export function createTakuwaeAuth(supabase) {
  if (!supabase?.auth) throw new Error('Supabase Auth client is required');

  return {
    async getSession() {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      return data.session ?? null;
    },

    async sendEmailCode(email) {
      if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        throw new Error('Enter a valid email address');
      }
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: { shouldCreateUser: true },
      });
      if (error) throw error;
      return { sent: true };
    },

    async verifyEmailCode(email, token) {
      if (!email?.trim() || !/^\d{6,8}$/.test(String(token).trim())) {
        throw new Error('Email and verification code are required');
      }
      const { data, error } = await supabase.auth.verifyOtp({
        email: email.trim(),
        token: String(token).trim(),
        type: 'email',
      });
      if (error) throw error;
      return data.session ?? null;
    },

    onAuthChange(callback) {
      if (typeof callback !== 'function') throw new TypeError('Callback is required');
      const { data } = supabase.auth.onAuthStateChange((event, session) => {
        callback({ event, userId: session?.user?.id ?? null });
      });
      return () => data.subscription.unsubscribe();
    },

    async signOut() {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    },
  };
}
