import { createTransport, type SMTPTransportOptions, type Transporter } from 'nodemailer';

/**
 * `EmailSender` — the port that hands one finished email to a mail server, and the vocabulary
 * around it.
 *
 * Decisions settled here and used by every later spec:
 *
 * 1. **The port takes a rendered message, not a template name and a payload.** Its whole job is
 *    transport. Rendering is a pure function of `(kind, payload)` and can be tested without a
 *    socket, a container or a fake; pushing it behind the port would drag template text into
 *    every test that only wanted to assert *that* an email went out, and would make a provider
 *    adapter that renders server-side (SES templates) look like a legitimate implementation of
 *    the same interface when it is really a different contract.
 * 2. **Rendering happens at send time, not at enqueue time.** The queue row stores `kind` and
 *    `payload` — see `../email/queue.ts` — precisely so that the text is produced when the email
 *    leaves, by the code that is deployed then. A wording fix therefore also fixes the emails
 *    still waiting in the queue, a queue row stays small and readable, and a payload of plain
 *    values survives a template that changes shape far better than a frozen blob of rendered
 *    HTML would. `EmailTemplate` below is that seam.
 * 3. **A template registry keyed by a plain string, not a closed union of kinds.** Five later
 *    specs each add their own kinds (verification, password reset, invoice issued, monthly
 *    report, complaint reply). A union declared here would make every one of those tickets edit
 *    this file, so instead the registry a worker is given is the authority on which kinds exist,
 *    and a kind with no template fails that one row permanently and loudly.
 * 4. **The sender's address is configuration, not part of a message.** One installation sends as
 *    one address; putting `from` on every message would mean every call site could get it
 *    subtly wrong. It is read once from `EMAIL_FROM`.
 * 5. **`send` either resolves or rejects, and never reports a partial success.** The queue row is
 *    the record of what happened, so there is nothing useful to return. A sender that knows a
 *    failure will never succeed — a rejected recipient, a message the server refuses — throws
 *    `PermanentEmailError` so the worker stops retrying it instead of burning five attempts on a
 *    verdict that will not change.
 *
 * The real implementation is `SmtpEmailSender`, which talks to Mailpit in the local environment.
 * The fake is `FakeEmailSender` in `./fakes.ts`, and it collects messages into an array a test
 * can read.
 */

/**
 * The values a template needs to produce its text, as stored in the queue row's `jsonb` column.
 *
 * Deliberately a plain JSON object rather than a per-kind type: the row is read back from the
 * database as `unknown` shaped data, so a template has to check what it got regardless of what
 * the type said at the enqueue site. Keep payloads small and made of values that stay true —
 * identifiers, amounts, dates — rather than sentences that a template should be writing.
 */
export type EmailPayload = Readonly<Record<string, unknown>>;

/** The text of one email: what a template produces, with no recipient yet. */
export interface RenderedEmail {
	readonly subject: string;
	/** The plain-text body. Always present: it is what a mail client without HTML shows. */
	readonly text: string;
	/** The HTML body, when the email has one. */
	readonly html?: string;
}

/** One email ready to be handed to a mail server. */
export interface EmailMessage extends RenderedEmail {
	/** The recipient's address. Exactly one: fan-out is one queue row per recipient. */
	readonly to: string;
}

/** Turns the payload stored on a queue row into the text of an email. */
export type EmailTemplate = (payload: EmailPayload) => RenderedEmail;

/**
 * Every email kind the application can send, keyed by the `kind` stored on a queue row. A worker
 * is given one of these; a kind that is not in it cannot be sent.
 */
export type EmailTemplates = Readonly<Record<string, EmailTemplate>>;

/** Sends one email. The only way the application reaches a mail server. */
export interface EmailSender {
	/**
	 * Sends `message`, resolving once the mail server has accepted it.
	 *
	 * @throws {PermanentEmailError} when the failure will not be fixed by trying again.
	 * @throws {Error} for any other failure, which the worker treats as worth retrying.
	 */
	send(message: EmailMessage): Promise<void>;
}

/**
 * A failure that retrying cannot fix: a rejected recipient, a message the server refused, a kind
 * with no template. The worker marks such a row failed immediately rather than waiting out the
 * whole retry schedule for an answer that will not change.
 */
export class PermanentEmailError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'PermanentEmailError';
	}
}

/** Everything `SmtpEmailSender` needs to reach a mail server. */
export interface SmtpSettings {
	readonly host: string;
	readonly port: number;
	/** The address every email is sent from. */
	readonly from: string;
	/**
	 * Credentials for a mail server that requires authentication. `undefined` for one that does
	 * not, which is Mailpit in the local environment. Set together, never alone: `readSmtpSettings`
	 * enforces that below.
	 */
	readonly auth?: {
		readonly user: string;
		readonly pass: string;
	};
}

/** The lowest SMTP response code that means "this message will never be accepted". */
const FIRST_PERMANENT_SMTP_CODE = 500;

/** One past the highest SMTP response code. */
const PAST_LAST_SMTP_CODE = 600;

/** The highest port number a TCP port can have. */
const HIGHEST_PORT = 65_535;

/**
 * Turns `SmtpSettings` into the options `nodemailer`'s SMTP transport takes: `host`, `port` and
 * `secure: false` always, plus `auth` and `requireTLS: true` together when `settings.auth` is
 * set. Exported so a test can assert on this exact shape, the same object a running
 * `SmtpEmailSender` hands to `createTransport`, without constructing a transport or opening a
 * socket to do it.
 */
export function smtpTransportOptions(settings: SmtpSettings): SMTPTransportOptions {
	const base: SMTPTransportOptions = {
		host: settings.host,
		port: settings.port,
		// `secure: false` means "do not start the connection inside TLS". It does not forbid
		// STARTTLS: when a server offers it, the client still upgrades. Mailpit offers neither.
		secure: false
	};
	if (settings.auth === undefined) {
		return base;
	}
	return {
		...base,
		auth: settings.auth,
		// Offered STARTTLS is not enough once a password is going over the wire: `requireTLS`
		// fails the connection instead of falling back to sending credentials in the clear to a
		// server that did not upgrade.
		requireTLS: true
	};
}

/**
 * Sends email over SMTP. In the local environment that is Mailpit, which accepts everything and
 * shows it in a web interface at http://localhost:8025 instead of delivering it to anyone.
 *
 * Authentication is optional, decided by whether `settings.auth` is set. Unauthenticated is
 * Mailpit's case: no credentials, no forced TLS, the same transport this class has always built.
 * The moment credentials are given, STARTTLS becomes mandatory (`requireTLS: true`) rather than
 * merely offered, so a login and password never cross the wire to a server that only pretended to
 * upgrade. See `smtpTransportOptions` for the exact shape handed to the underlying SMTP client.
 */
export class SmtpEmailSender implements EmailSender {
	readonly #from: string;
	readonly #transport: Transporter;

	constructor(settings: SmtpSettings) {
		this.#from = settings.from;
		this.#transport = createTransport(smtpTransportOptions(settings));
	}

	async send(message: EmailMessage): Promise<void> {
		try {
			await this.#transport.sendMail({
				from: this.#from,
				to: message.to,
				subject: message.subject,
				text: message.text,
				html: message.html
			});
		} catch (error) {
			throw permanentWhenRefused(error, message.to);
		}
	}
}

/**
 * Turns a send failure into a `PermanentEmailError` when the mail server answered with a 5xx
 * code, which by the SMTP specification means the message is being refused rather than deferred.
 * Anything else — a connection that was not accepted, a timeout, a 4xx — is left as it is, and
 * the worker retries it.
 */
function permanentWhenRefused(error: unknown, recipient: string): unknown {
	const code = smtpResponseCode(error);
	if (code === undefined || code < FIRST_PERMANENT_SMTP_CODE || code >= PAST_LAST_SMTP_CODE) {
		return error;
	}
	return new PermanentEmailError(
		`The mail server refused the message to ${recipient} with SMTP code ${code}.`,
		{ cause: error }
	);
}

/** Reads the SMTP response code off a send failure, when it carries one. */
function smtpResponseCode(error: unknown): number | undefined {
	if (typeof error !== 'object' || error === null || !('responseCode' in error)) {
		return undefined;
	}
	const code = (error as { responseCode: unknown }).responseCode;
	return typeof code === 'number' ? code : undefined;
}

/**
 * Builds the sender the running application uses, from `SMTP_HOST`, `SMTP_PORT` and `EMAIL_FROM`.
 *
 * The two views of the mail server do not agree and cannot be made to: inside the Compose network
 * the host name is `mailpit`, and from a process running on the host machine it is `localhost` on
 * the published port. `.env` carries the host machine's view and `docker-compose.yml` writes the
 * container's view itself, the same way it already does for `DATABASE_URL`.
 */
export function smtpEmailSenderFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env
): EmailSender {
	return new SmtpEmailSender(readSmtpSettings(environment));
}

/**
 * Reads the SMTP settings out of an environment.
 *
 * @throws {Error} with a message naming the variable, when one is missing or unusable. The
 *   driver's own failure for an empty host is a `TypeError` several frames deep in a socket call,
 *   which says nothing about which line of `.env` is wrong. The same is true of `SMTP_USER` and
 *   `SMTP_PASS`: set alone, either is reported by name rather than left to fail inside the SMTP
 *   client with no clue which variable was forgotten.
 */
export function readSmtpSettings(environment: NodeJS.ProcessEnv = process.env): SmtpSettings {
	return {
		host: requiredSetting(environment, 'SMTP_HOST'),
		port: readPort(requiredSetting(environment, 'SMTP_PORT')),
		from: requiredSetting(environment, 'EMAIL_FROM'),
		auth: readSmtpAuth(environment)
	};
}

/**
 * Reads `SMTP_USER` and `SMTP_PASS` as an optional pair. `undefined` when neither is set, which
 * is Mailpit's case. When exactly one is set, that is a configuration mistake rather than a
 * partial setup nobody intended, so it is reported the same way a missing required setting is:
 * by the name of the variable that is missing, through `requiredSetting`.
 */
function readSmtpAuth(
	environment: NodeJS.ProcessEnv
): { readonly user: string; readonly pass: string } | undefined {
	const user = optionalSetting(environment, 'SMTP_USER');
	const pass = optionalSetting(environment, 'SMTP_PASS');
	if (user === undefined && pass === undefined) {
		return undefined;
	}
	return {
		user: user ?? requiredSetting(environment, 'SMTP_USER'),
		pass: pass ?? requiredSetting(environment, 'SMTP_PASS')
	};
}

/** Reads one variable that has to be present and not blank. */
function requiredSetting(environment: NodeJS.ProcessEnv, name: string): string {
	const value = environment[name]?.trim();
	if (!value) {
		throw new Error(
			`Environment variable ${name} is not set. Copy .env.example to .env; its Mailpit section has a working value for every SMTP setting.`
		);
	}
	return value;
}

/**
 * Reads one variable that is allowed to be absent, treating a blank value the same as an absent
 * one: `SMTP_USER=` with nothing after it is not a username.
 */
function optionalSetting(environment: NodeJS.ProcessEnv, name: string): string | undefined {
	const value = environment[name]?.trim();
	return value ? value : undefined;
}

/** Parses a port number, rejecting anything that is not one. */
function readPort(value: string): number {
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > HIGHEST_PORT) {
		throw new TypeError(
			`Environment variable SMTP_PORT is "${value}", which is not a port number between 1 and ${HIGHEST_PORT}.`
		);
	}
	return port;
}
