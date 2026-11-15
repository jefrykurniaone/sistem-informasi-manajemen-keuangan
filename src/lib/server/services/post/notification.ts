import type { Database } from '../../db';
import type { Post } from '../../db/schema/post';
import { announce, everyResident } from '../../email/announce';
import { newPostPayload, NEW_POST_KIND } from '../../email/templates/new-post';
import type { Clock } from '../../ports/clock';

/**
 * The `new-post` email for a Post's first publication — the recipient side of #41. `./index.ts`
 * calls `notifyNewPost` exactly once, from `publishPost`, after the transaction that changed the
 * Post's status has already committed, and wraps the call in `announceAfterCommit` so that a failure
 * here never reports a published Post as unpublished. See that module's doc comment for why the call
 * sits there and not inside `changePostStatus`.
 *
 * This module only says what the email is and who it is addressed to: every resident, with the
 * title, the summary and the public link of the Post — never the Markdown body.
 * `../../email/announce.ts` does everything else: `new-post` is an opt-in kind, so it goes only to
 * the residents subscribed to it and carries each one's unsubscribe link, and the public link is
 * built from the configured `ORIGIN`. A Post published while nobody is subscribed queues nothing.
 */

/**
 * Queues one `new-post` email to every resident subscribed to it.
 *
 * @param db the plain database, once the publication has committed — never a transaction handle.
 * @throws whatever `announce` throws; `publishPost` is the caller that keeps it from failing the
 *   publication.
 */
export async function notifyNewPost(db: Database, clock: Clock, post: Post): Promise<void> {
	await announce(db, clock, {
		kind: NEW_POST_KIND,
		recipients: everyResident,
		payload: ({ link, locale }) =>
			newPostPayload({
				title: post.title,
				summary: post.summary,
				url: link(`/posts/${post.id}`),
				locale
			})
	});
}
