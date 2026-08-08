import type { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import { authCtx } from './db.js';
import 'dotenv/config';

// Service-role client: used only to validate a caller's JWT and read its user id.
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

// Gate every /api route: require a valid Supabase access token, then run the rest of
// the request inside an auth context so DB helpers can scope by user (see db.uid()).
// ponytail: getUser() is one network hop to Supabase per request — fine for a personal
// app. If latency matters, verify the JWT locally with the project's JWT secret instead.
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Not signed in' });

  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: 'Invalid or expired session' });
    authCtx.run({ userId: data.user.id }, () => next());
  } catch (err) {
    next(err); // network/Supabase failure -> central error handler
  }
}
