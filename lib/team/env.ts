/**
 * Environment variable getters for Firebase and App configuration.
 */

export function firebaseProjectId(): string | null {
  return process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || null;
}

export function requireFirebaseProjectId(): string {
  const id = firebaseProjectId();
  if (!id) throw new Error('FIREBASE_PROJECT_ID is required');
  return id;
}

export function firebaseServiceAccount(): string | null {
  return process.env.FIREBASE_SERVICE_ACCOUNT || null;
}

export function requireFirebaseServiceAccount(): string {
  const sa = firebaseServiceAccount();
  if (!sa) throw new Error('FIREBASE_SERVICE_ACCOUNT is required');
  return sa;
}

export function adminPassword(): string | null {
  return process.env.ADMIN_PASSWORD || null;
}

export function superadminPassword(): string | null {
  return process.env.SUPERADMIN_PASSWORD || null;
}

export function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret) return secret;

  const adminPwd = process.env.ADMIN_PASSWORD;
  if (adminPwd) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        '[security] SESSION_SECRET is not set. Falling back to ADMIN_PASSWORD as the session ' +
        'signing secret. Set SESSION_SECRET to a separate random value so that rotating ' +
        'ADMIN_PASSWORD does not invalidate all active sessions.'
      );
    }
    return adminPwd;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'CRITICAL SECURITY ERROR: SESSION_SECRET or ADMIN_PASSWORD must be configured in production mode. ' +
      'Refusing to fallback to insecure default secret.'
    );
  }
  return 'dev-insecure-change-me';
}

export function cronSecret(): string | null {
  return process.env.CRON_SECRET || null;
}
