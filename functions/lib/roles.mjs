// Who may use the administrator sections.
//
// The role is a server-side row in app.user_roles, never a flag the browser can
// set and never a field on the student's profile. A student who learns the
// admin URLs still gets 403, because the check happens here, on the server,
// before any route body runs.
//
// The first administrator is bootstrapped from a Site Secret so the platform
// can be handed over without editing the database by hand:
//   ADMIN_OWNER_IDS = "owner-id-one,owner-id-two"

const ADMIN_ROLES = new Set(['admin', 'owner']);

export function createRoles({ db, rows, env }) {
  const readEnv = typeof env === 'function' ? env : () => undefined;

  // The ids allowed in from the secret. Read on every call so a secret change
  // takes effect without a redeploy.
  function bootstrapAdmins() {
    const raw = readEnv('ADMIN_OWNER_IDS') || readEnv('ADMIN_OWNER_ID') || '';
    const ids = new Set();
    for (const part of String(raw).split(/[\s,;]+/)) {
      const id = part.trim().toLowerCase();
      if (id) ids.add(id);
    }
    return ids;
  }

  async function roleOf(ownerId) {
    const id = String(ownerId || '').trim().toLowerCase();
    if (!id) return 'student';
    const found = rows(await db.from('user_roles').select('owner_id,role').eq('owner_id', id).limit(1));
    const role = String(found?.[0]?.role || '').trim().toLowerCase();
    if (ADMIN_ROLES.has(role)) return 'admin';
    if (bootstrapAdmins().has(id)) return 'admin';
    return role || 'student';
  }

  async function isAdmin(ownerId) {
    return (await roleOf(ownerId)) === 'admin';
  }

  // Granting a role is a server-side write with its own audit trail.
  async function setRole(ownerId, role, grantedBy) {
    const id = String(ownerId || '').trim().toLowerCase();
    if (!id) return null;
    const wanted = ['admin', 'student'].includes(String(role)) ? String(role) : 'student';
    const updated = rows(await db.from('user_roles')
      .update({ role: wanted, granted_by: String(grantedBy || '').slice(0, 120), updated_at: new Date().toISOString() })
      .eq('owner_id', id).select('owner_id,role'));
    if (updated?.length) return updated[0];
    const inserted = rows(await db.from('user_roles').insertIfAbsent({
      id: crypto.randomUUID(), owner_id: id, role: wanted,
      granted_by: String(grantedBy || '').slice(0, 120),
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }, { onConflict: 'owner_id' }).select('owner_id,role'));
    return inserted?.[0] || null;
  }

  return { roleOf, isAdmin, setRole, bootstrapAdmins };
}
