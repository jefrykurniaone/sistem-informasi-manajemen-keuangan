import { readOrigin } from '../../auth';
import type { Database } from '../../db';
import type { Post } from '../../db/schema/post';
import { enqueueEmail } from '../../email/queue';
import { newPostPayload, NEW_POST_KIND } from '../../email/templates/new-post';
import type { Clock } from '../../ports/clock';
import { residentsSubscribedTo } from '../subscription';
import { SUBSCRIPTION_KIND } from '../subscription/kinds';

/**
 * Queuing the `new-post` email for a Post's first publication — the recipient side of #41. `./index.ts`
 * calls `notifyNewPost` exactly once, from `publishPost`, after the transaction that changed the
 * Post's status has already committed. See that module's doc comment for why the call sits there and
 * not inside `changePostStatus`.
 *
 * ## Who receives it
 *
 * `residentsSubscribedTo(db, SUBSCRIPTION_KIND.newPost)` is the whole answer: it already applies the
 * kind's registry default (opt-in, off) for a resident who has never answered, so this module never
 * has to know that rule itself. A Post published while nobody is subscribed enqueues nothing, which
 * is not a special case — the loop below is simply empty.
 *
 * ## What every recipient is sent
 *
 * One `email_queue` row per subscribed resident, all built from the same payload — the title, the
 * summary, and the public link, never the Markdown body. The link is built from `readOrigin()`,
 * never from a request header a client could bend, the same rule `approveRegistration` and the
 * invitation flow already follow for their own links.
 */

/** The locale every `new-post` email renders in, until a resident's own language is a stored fact. */
const NEW_POST_EMAIL_LOCALE = 'id';

/** The path segment of the public detail page, relative to `readOrigin()`. */
function publicPostUrl(postId: string): string {
	return `${readOrigin()}/posts/${postId}`;
}

/**
 * Queues one `new-post` email to every resident currently subscribed to it.
 *
 * @param db the database to enqueue on. The caller passes the plain database once its own
 *   transaction has already committed — never a transaction handle, which would put the email back
 *   inside the window it is deliberately outside of.
 */
export async function notifyNewPost(db: Database, clock: Clock, post: Post): Promise<void> {
	const recipients = await residentsSubscribedTo(db, SUBSCRIPTION_KIND.newPost);
	if (recipients.length === 0) {
		return;
	}

	const payload = newPostPayload({
		title: post.title,
		summary: post.summary,
		url: publicPostUrl(post.id),
		locale: NEW_POST_EMAIL_LOCALE
	});

	for (const recipient of recipients) {
		await enqueueEmail(db, clock, {
			recipient: recipient.email,
			kind: NEW_POST_KIND,
			payload
		});
	}
}
