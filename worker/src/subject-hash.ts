/**
 * The candidate-level erasure index, shared by the Worker and the erasure tool.
 *
 * IT LIVES IN ITS OWN MODULE FOR ONE REASON: THERE MUST BE EXACTLY ONE OF IT.
 *
 * The Worker writes this digest onto every stored resume. `scripts/erase-candidate.ts`
 * answers "delete everything belonging to this person" by recomputing it and
 * matching. Those two computations are the same function or they are a bug —
 * and a bug of the worst available shape, because a drifted hash matches
 * nothing, reports "0 objects", and records a deletion request as honoured
 * while every CV is still in the bucket. Nothing about that failure is visible
 * from either side.
 *
 * So the script does not reimplement this, does not copy it, and does not
 * re-derive the normalisation rules from the comment below. It imports this
 * file. `scripts/erase-candidate.test.ts` and `worker/src/index.worker.test.ts`
 * both pin the output to the same independently computed literal, so even a
 * shared edit cannot move both sides silently.
 */

/**
 * `HMAC-SHA-256(normalised email, salt)`, hex encoded.
 *
 * WHY A SALTED HMAC RATHER THAN A DIGEST. Storing the address itself would put
 * PII in object metadata. Storing a plain SHA-256 would let anyone holding the
 * bucket confirm a guessed address, which for an email is a very short guess.
 * The salted HMAC is reversible only to whoever holds the salt, and still lets
 * us answer the deletion question by recomputing it.
 *
 * WHY NORMALISE FIRST, AND WHY THIS IS THE FRAGILE PART. The same person typing
 * their address with different capitalisation, or with a space the autofill
 * left behind, produces two different digests — so a deletion request silently
 * misses one of their submissions. Case and surrounding whitespace are stripped
 * before signing for that reason, and only those two: anything more aggressive
 * (stripping dots, cutting at a `+`) would start merging addresses that belong
 * to different people and delete a stranger's CV.
 *
 * The salt is used RAW. It is a key, not user input, and trimming it here while
 * the operator exports it untrimmed would produce two different digests from
 * one configured value.
 */
export async function computeSubjectHash(
  email: string,
  salt: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(salt),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(email.trim().toLowerCase()),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
