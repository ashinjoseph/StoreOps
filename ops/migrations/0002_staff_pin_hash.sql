-- P2-06: sign-in. The PIN is stored only as a slow salted hash (never plain text).
alter table ops.staff add column pin_hash text;

comment on column ops.staff.pin_hash is
  'pbkdf2-sha256$<iterations>$<salt base64>$<hash base64> of HMAC-SHA-256(pepper, PIN); NULL = this person cannot sign in until a PIN is set';
