import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	PermanentEmailError,
	readSmtpSettings,
	smtpTransportOptions,
	SmtpEmailSender,
	type EmailMessage
} from '$lib/server/ports/email';
import { FakeEmailSender } from '$lib/server/ports/fakes';

/**
 * The `EmailSender` port: the fake that tests use, and the SMTP implementation that Mailpit sees.
 *
 * The SMTP tests run against a mail server started inside this file rather than against Mailpit.
 * That is deliberate: the quality gate runs on a machine with no Mailpit, and a test that quietly
 * skips itself there would be a test that only ever proves something on one laptop. A socket
 * speaking the protocol proves the same thing everywhere — that this sender really opens a
 * connection, really speaks SMTP, and really turns the server's answer into the right error.
 */

/** The line ending SMTP uses between commands and responses. */
const CRLF = '\r\n';

/** The response a sink gives when the test has not asked for a different one. */
const ACCEPTED = '250 ok';

/** One message as the sink received it, headers and body together. */
type ReceivedMessage = string;

interface SmtpSink {
	readonly port: number;
	readonly messages: readonly ReceivedMessage[];
	/** Makes the sink answer the next `RCPT TO` with this response, for example `550 no mailbox`. */
	answerRecipientWith(response: string): void;
	close(): Promise<void>;
}

/** Starts a mail server on a port the operating system picks, and remembers what it is given. */
async function startSmtpSink(): Promise<SmtpSink> {
	const messages: ReceivedMessage[] = [];
	const sockets = new Set<net.Socket>();
	let recipientResponse = ACCEPTED;

	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		socket.setEncoding('utf8');
		socket.write(`220 sink ready${CRLF}`);

		let pending = '';
		let body: string[] | undefined;
		socket.on('data', (chunk) => {
			pending += chunk.toString();
			const lines = pending.split(CRLF);
			pending = lines.pop() ?? '';
			for (const line of lines) {
				body = handleLine({ socket, line, body, messages, recipientResponse });
			}
		});
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new TypeError('The sink did not get a TCP port.');
	}

	return {
		port: address.port,
		messages,
		answerRecipientWith: (response) => {
			recipientResponse = response;
		},
		close: () =>
			new Promise<void>((resolve, reject) => {
				for (const socket of sockets) {
					socket.destroy();
				}
				server.close((error) => (error ? reject(error) : resolve()));
			})
	};
}

/**
 * Answers one line from the client. Returns the message body collected so far, or `undefined`
 * when the connection is not inside a `DATA` block.
 */
function handleLine(context: {
	socket: net.Socket;
	line: string;
	body: string[] | undefined;
	messages: ReceivedMessage[];
	recipientResponse: string;
}): string[] | undefined {
	const { socket, line, body, messages, recipientResponse } = context;
	if (body !== undefined) {
		if (line !== '.') {
			body.push(line);
			return body;
		}
		messages.push(body.join('\n'));
		socket.write(`250 queued${CRLF}`);
		return undefined;
	}

	const command = line.split(' ')[0].toUpperCase();
	switch (command) {
		case 'EHLO':
			socket.write(`250-sink${CRLF}250 8BITMIME${CRLF}`);
			return undefined;
		case 'HELO':
		case 'MAIL':
		case 'RSET':
			socket.write(`${ACCEPTED}${CRLF}`);
			return undefined;
		case 'RCPT':
			socket.write(`${recipientResponse}${CRLF}`);
			return undefined;
		case 'DATA':
			socket.write(`354 go ahead${CRLF}`);
			return [];
		case 'QUIT':
			socket.write(`221 bye${CRLF}`);
			socket.end();
			return undefined;
		default:
			socket.write(`502 not implemented${CRLF}`);
			return undefined;
	}
}

const message: EmailMessage = {
	to: 'warga@komplek.local',
	subject: 'Tagihan bulan ini',
	text: 'Iuran bulan ini sudah terbit.'
};

describe('FakeEmailSender', () => {
	it('collects every message it is given, in order', async () => {
		const sender = new FakeEmailSender();

		await sender.send(message);
		await sender.send({ ...message, to: 'admin@komplek.local' });

		expect(sender.messages.map((sent) => sent.to)).toEqual([
			'warga@komplek.local',
			'admin@komplek.local'
		]);
	});

	it('keeps the whole message, so a test can assert on its text', async () => {
		const sender = new FakeEmailSender();

		await sender.send(message);

		expect(sender.lastMessage).toEqual(message);
	});

	it('has nothing to show before anything is sent', () => {
		expect(new FakeEmailSender().lastMessage).toBeUndefined();
	});

	it('fails every send once it is told to, the way an unreachable mail server does', async () => {
		const sender = new FakeEmailSender();
		sender.failWith(new Error('connect ECONNREFUSED'));

		await expect(sender.send(message)).rejects.toThrow('connect ECONNREFUSED');
		expect(sender.messages).toHaveLength(0);
	});

	it('works again after it is told to stop failing', async () => {
		const sender = new FakeEmailSender();
		sender.failWith(new Error('the mail server is down'));
		await expect(sender.send(message)).rejects.toThrow();

		sender.stopFailing();
		await sender.send(message);

		expect(sender.messages).toHaveLength(1);
	});

	it('forgets its messages when cleared', async () => {
		const sender = new FakeEmailSender();
		await sender.send(message);

		sender.clear();

		expect(sender.messages).toHaveLength(0);
	});
});

describe('readSmtpSettings', () => {
	const complete = {
		SMTP_HOST: 'localhost',
		SMTP_PORT: '1025',
		EMAIL_FROM: 'no-reply@komplek.local'
	};

	it('reads the three settings', () => {
		expect(readSmtpSettings(complete)).toEqual({
			host: 'localhost',
			port: 1025,
			from: 'no-reply@komplek.local'
		});
	});

	it.each(['SMTP_HOST', 'SMTP_PORT', 'EMAIL_FROM'])(
		'rejects a missing %s with a message naming it',
		(name) => {
			expect(() => readSmtpSettings({ ...complete, [name]: undefined })).toThrow(
				new RegExp(`${name} is not set`)
			);
		}
	);

	it.each(['SMTP_HOST', 'SMTP_PORT', 'EMAIL_FROM'])('rejects a blank %s', (name) => {
		expect(() => readSmtpSettings({ ...complete, [name]: '   ' })).toThrow(/is not set/);
	});

	it.each([
		{ name: 'not a number', input: 'mailpit' },
		{ name: 'a fraction', input: '1025.5' },
		{ name: 'zero', input: '0' },
		{ name: 'past the highest port', input: '70000' }
	])('rejects a port that is $name', ({ input }) => {
		expect(() => readSmtpSettings({ ...complete, SMTP_PORT: input })).toThrow(TypeError);
	});

	it('has no auth when neither SMTP_USER nor SMTP_PASS is set, the Mailpit case', () => {
		expect(readSmtpSettings(complete).auth).toBeUndefined();
	});

	it('reads SMTP_USER and SMTP_PASS into auth when both are set', () => {
		expect(
			readSmtpSettings({
				...complete,
				SMTP_USER: 'no-reply@gmail.com',
				SMTP_PASS: 'an-app-password'
			}).auth
		).toEqual({ user: 'no-reply@gmail.com', pass: 'an-app-password' });
	});

	it('treats a blank SMTP_USER and a blank SMTP_PASS as both absent, same as Mailpit', () => {
		expect(readSmtpSettings({ ...complete, SMTP_USER: '   ', SMTP_PASS: '' }).auth).toBeUndefined();
	});

	it.each([
		{ set: 'SMTP_USER', missing: 'SMTP_PASS' },
		{ set: 'SMTP_PASS', missing: 'SMTP_USER' }
	])('rejects $set set alone, naming $missing as the one that is missing', ({ set, missing }) => {
		expect(() => readSmtpSettings({ ...complete, [set]: 'a-value' })).toThrow(
			new RegExp(`${missing} is not set`)
		);
	});

	it('treats a blank partner the same as an absent one: SMTP_USER set with a blank SMTP_PASS is reported as SMTP_PASS missing', () => {
		expect(() =>
			readSmtpSettings({ ...complete, SMTP_USER: 'no-reply@gmail.com', SMTP_PASS: '  ' })
		).toThrow(/SMTP_PASS is not set/);
	});
});

describe('smtpTransportOptions', () => {
	const settings = { host: 'localhost', port: 1025, from: 'no-reply@komplek.local' };

	it('has no auth and no requireTLS when the settings carry no auth, the Mailpit case', () => {
		expect(smtpTransportOptions(settings)).toEqual({
			host: 'localhost',
			port: 1025,
			secure: false
		});
	});

	it('adds auth and requireTLS when the settings carry auth', () => {
		const withAuth = {
			...settings,
			auth: { user: 'no-reply@gmail.com', pass: 'an-app-password' }
		};

		expect(smtpTransportOptions(withAuth)).toEqual({
			host: 'localhost',
			port: 1025,
			secure: false,
			auth: { user: 'no-reply@gmail.com', pass: 'an-app-password' },
			requireTLS: true
		});
	});
});

describe('SmtpEmailSender', () => {
	let sink: SmtpSink;

	beforeAll(async () => {
		sink = await startSmtpSink();
	});

	afterAll(async () => {
		await sink.close();
	});

	function senderTo(): SmtpEmailSender {
		return new SmtpEmailSender({
			host: '127.0.0.1',
			port: sink.port,
			from: 'no-reply@komplek.local'
		});
	}

	it('delivers the message to the mail server over SMTP', async () => {
		sink.answerRecipientWith(ACCEPTED);

		await senderTo().send({
			to: 'warga@komplek.local',
			subject: 'Verification',
			text: 'Open the link to verify your address.'
		});

		const received = sink.messages.at(-1) ?? '';
		expect(received).toContain('To: warga@komplek.local');
		expect(received).toContain('Subject: Verification');
		expect(received).toContain('Open the link to verify your address.');
	});

	it('sends from the one configured address, not from anything the caller passed', async () => {
		sink.answerRecipientWith(ACCEPTED);

		await senderTo().send({ to: 'warga@komplek.local', subject: 'From', text: 'Body.' });

		expect(sink.messages.at(-1) ?? '').toContain('From: no-reply@komplek.local');
	});

	it('turns a refused recipient into a permanent failure, so it is not retried', async () => {
		sink.answerRecipientWith('550 no such mailbox');

		await expect(
			senderTo().send({ to: 'tidak-ada@komplek.local', subject: 'Refused', text: 'Body.' })
		).rejects.toThrow(PermanentEmailError);
	});

	it('leaves a temporary refusal as an ordinary failure, so it is retried', async () => {
		sink.answerRecipientWith('451 try again later');

		const failure: unknown = await senderTo()
			.send({ to: 'warga@komplek.local', subject: 'Deferred', text: 'Body.' })
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(Error);
		expect(failure).not.toBeInstanceOf(PermanentEmailError);
	});
});
