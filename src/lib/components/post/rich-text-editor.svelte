<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
	import type { Editor } from '@tiptap/core';
	import * as m from '$lib/paraglide/messages.js';

	/**
	 * The Post body editor — `docs/spec-post-editor-v1.md`'s "admin mengetik, menebalkan lewat tombol
	 * atau Ctrl+B, membuat judul bagian, daftar, dan tautan, melihat hasilnya saat itu juga".
	 *
	 * ## It is a form field, not an application
	 *
	 * Everything this component produces leaves through one `<input type="hidden">` carrying
	 * `editor.getHTML()`, rewritten on every `onTransaction`. The screen around it therefore stays a
	 * plain SvelteKit form action — no `fetch`, no `use:enhance`, no JSON — and the server reads
	 * `bodyHtml` out of `FormData` exactly as it did when this was a `<textarea>`.
	 *
	 * That also decides what happens when the editor never mounts, because JavaScript is off or has
	 * not run yet: the hidden input already holds the `value` it was given, so saving the form keeps
	 * the stored body instead of blanking it.
	 *
	 * **Nothing here is a security boundary.** `sanitizePostHtml` in
	 * `src/lib/server/services/post/sanitize.ts` is, and it runs on the server against whatever
	 * arrives in that hidden input — which anybody can set to anything, with or without this
	 * component. The toolbar below is fitted to that whitelist rather than the other way round: it
	 * offers no underline and no strikethrough, because Tiptap writes those as `<u>` and `<s>` and the
	 * whitelist keeps neither, so a button for them would silently lose its own formatting on save.
	 *
	 * ## Why Tiptap is loaded inside `onMount`
	 *
	 * `@tiptap/core` and `@tiptap/starter-kit` are imported dynamically rather than at the top of this
	 * module so that neither package is in the server's module graph at all. A rich-text editor is a
	 * browser thing — it wants `document` to build a ProseMirror view — and a static import would make
	 * every server render of a Post form depend on that whole tree parsing cleanly under Node. The
	 * `Editor` type is imported statically, which costs nothing: a type import is erased.
	 *
	 * @see `src/lib/components/post/post-form.svelte` — the only screen that mounts this.
	 */

	interface Props {
		/** The form field name the body is submitted under. Always `bodyHtml`. */
		readonly name: string;
		/** The HTML the editor opens with, and what the hidden input carries until it mounts. */
		readonly value: string;
		/** Put on the editable area itself, so a caller can point at it. */
		readonly id: string;
		/** The id of the element naming this field, put on the editable area as `aria-labelledby`. The
		 *  editable area is a `textbox` to a screen reader, but a `<div>` is not labelable, so the
		 *  label is attached this way and not with `<label for>`. */
		readonly labelledBy?: string;
		/** The id of the element holding this field's hint, put on the editable area as
		 *  `aria-describedby`. Spelled without the `aria-` prefix for the same reason as `labelledBy`:
		 *  `svelte/no-unused-props` does not follow a quoted, renamed destructuring key and reports
		 *  both as unused. */
		readonly describedBy?: string;
	}

	let {
		name,
		value,
		id,
		labelledBy = undefined,
		describedBy = undefined
	}: Readonly<Props> = $props();

	/** The heading level "Judul 2" makes: a section inside a Post body. */
	const SECTION_HEADING_LEVEL = 2;

	/** The heading level "Judul 3" makes: a subsection of one of those. */
	const SUBSECTION_HEADING_LEVEL = 3;

	/**
	 * The `prose` classes the editable area wears — the same ones `post-preview.svelte` puts on a
	 * rendered body, so that what an admin types looks like what a resident will read rather than
	 * merely close to it. `@tailwindcss/typography` is registered in `src/app.css`.
	 */
	const EDITOR_CLASS =
		'prose prose-neutral dark:prose-invert max-w-none min-h-48 px-3 py-2 text-sm focus:outline-none';

	/** What one toolbar button is. */
	interface ToolbarAction {
		/** Distinguishes this button from the others, and keys the `{#each}`. */
		readonly id: string;
		/** The label a person reads, as a message function so it follows the interface locale. */
		readonly label: () => string;
		/** What pressing it does. */
		readonly apply: (editor: Editor) => void;
		/** Whether the caret is currently inside what it makes — this is what `aria-pressed` reports. */
		readonly isActive: (editor: Editor) => boolean;
	}

	/**
	 * The toolbar, in the order it is shown. A table rather than seven near-identical blocks of
	 * markup: a button differs from its neighbour only in these four values, and the `{#each}` below
	 * is then the one place the markup, the `type="button"` and the `aria-pressed` live.
	 *
	 * The link button is deliberately not here — it opens a dialog instead of running a command, so it
	 * would be a fifth field that six of the seven rows leave empty.
	 */
	const TOOLBAR_ACTIONS: readonly ToolbarAction[] = [
		{
			id: 'heading2',
			label: m.adminPosts_editorHeading2,
			apply: (editor) => {
				editor.chain().focus().toggleHeading({ level: SECTION_HEADING_LEVEL }).run();
			},
			isActive: (editor) => editor.isActive('heading', { level: SECTION_HEADING_LEVEL })
		},
		{
			id: 'heading3',
			label: m.adminPosts_editorHeading3,
			apply: (editor) => {
				editor.chain().focus().toggleHeading({ level: SUBSECTION_HEADING_LEVEL }).run();
			},
			isActive: (editor) => editor.isActive('heading', { level: SUBSECTION_HEADING_LEVEL })
		},
		{
			id: 'bold',
			label: m.adminPosts_editorBold,
			apply: (editor) => {
				editor.chain().focus().toggleBold().run();
			},
			isActive: (editor) => editor.isActive('bold')
		},
		{
			id: 'italic',
			label: m.adminPosts_editorItalic,
			apply: (editor) => {
				editor.chain().focus().toggleItalic().run();
			},
			isActive: (editor) => editor.isActive('italic')
		},
		{
			id: 'bulletList',
			label: m.adminPosts_editorBulletList,
			apply: (editor) => {
				editor.chain().focus().toggleBulletList().run();
			},
			isActive: (editor) => editor.isActive('bulletList')
		},
		{
			id: 'orderedList',
			label: m.adminPosts_editorOrderedList,
			apply: (editor) => {
				editor.chain().focus().toggleOrderedList().run();
			},
			isActive: (editor) => editor.isActive('orderedList')
		}
	];

	/** Where Tiptap builds its editable area. */
	let host: HTMLDivElement | undefined;

	/** The link dialog, opened with `showModal` so that Escape closes it and focus stays inside. */
	let linkDialog: HTMLDialogElement | undefined;

	/**
	 * The live editor, once it has mounted.
	 *
	 * `$state.raw`, never plain `$state`: a plain one hands back a deep proxy of whatever it holds,
	 * and a proxied ProseMirror view is an editor whose internal identity checks compare a proxy with
	 * the object behind it. Nothing here reads a field of the editor reactively — the two values the
	 * markup follows are `bodyHtml` and `activeActionIds` below — so a raw reference is also all that
	 * is needed.
	 */
	let editor: Editor | undefined = $state.raw();

	/**
	 * What the hidden input carries: the editor's HTML, rewritten on every transaction.
	 *
	 * `untrack`, because capturing only the first `value` is exactly the intent and the compiler
	 * warns about it otherwise. Following the prop afterwards would be wrong: the editor owns the body
	 * from the moment it mounts, so a later `value` writing over it would throw away whatever the
	 * admin had typed since.
	 */
	let bodyHtml = $state(untrack(() => value));

	/** The ids of the toolbar actions the caret is currently inside. */
	let activeActionIds: readonly string[] = $state.raw([]);

	/** Whether the caret is inside a link, which is the link button's own `aria-pressed`. */
	let linkActive = $state(false);

	/** What the link dialog's address field holds while it is open. */
	let linkUrl = $state('');

	/** Set by `onDestroy`, so an editor whose dynamic import is still in flight is never built. */
	let destroyed = false;

	/**
	 * Copies everything the markup follows out of the editor.
	 *
	 * An empty document is reported as an empty string rather than as the `<p></p>` Tiptap really
	 * holds. That `<p></p>` survives the sanitizer, so without this a body nobody typed would reach
	 * `validatePostContent` looking like content and be stored as an empty paragraph, instead of being
	 * refused the way an empty `<textarea>` always was.
	 */
	function syncFromEditor(current: Editor): void {
		bodyHtml = current.isEmpty ? '' : current.getHTML();
		activeActionIds = TOOLBAR_ACTIONS.filter((action) => action.isActive(current)).map(
			(action) => action.id
		);
		linkActive = current.isActive('link');
	}

	/** The attributes Tiptap puts on the editable area it builds. */
	function editorAttributes(): Record<string, string> {
		const attributes: Record<string, string> = { id, class: EDITOR_CLASS };
		if (labelledBy) {
			attributes['aria-labelledby'] = labelledBy;
		}
		if (describedBy) {
			attributes['aria-describedby'] = describedBy;
		}
		return attributes;
	}

	onMount(async () => {
		const [core, starterKit] = await Promise.all([
			import('@tiptap/core'),
			import('@tiptap/starter-kit')
		]);
		if (destroyed || !host) {
			return;
		}

		const created = new core.Editor({
			element: host,
			content: value,
			extensions: [
				// `openOnClick` would follow a link while the admin is editing it, which loses the draft.
				// StarterKit 3 already carries Link and Underline, so neither is installed separately.
				starterKit.default.configure({ link: { openOnClick: false } })
			],
			editorProps: { attributes: editorAttributes() },
			onTransaction: ({ editor: current }) => syncFromEditor(current)
		});

		editor = created;
		syncFromEditor(created);
	});

	onDestroy(() => {
		destroyed = true;
		editor?.destroy();
		editor = undefined;
	});

	/** Runs one toolbar action against the live editor, or nothing while there is none. */
	function runAction(action: ToolbarAction): void {
		if (!editor) {
			return;
		}
		action.apply(editor);
	}

	/** Opens the link dialog, filled with the address of the link the caret is already inside. */
	function openLinkDialog(): void {
		if (!editor || !linkDialog) {
			return;
		}
		const existing: unknown = editor.getAttributes('link').href;
		linkUrl = typeof existing === 'string' ? existing : '';
		linkDialog.showModal();
	}

	/**
	 * Puts the typed address on the selection, widened to the whole link when the caret was inside
	 * one so that editing an address does not split it in two.
	 */
	function applyLink(): void {
		const href = linkUrl.trim();
		if (!editor || href === '') {
			return;
		}
		editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
		linkDialog?.close();
	}

	/** Takes the link off the text and leaves the words. */
	function removeLink(): void {
		if (!editor) {
			return;
		}
		editor.chain().focus().extendMarkRange('link').unsetLink().run();
		linkDialog?.close();
	}

	/**
	 * Enter in the address field applies the link.
	 *
	 * `preventDefault` is not a nicety here: this dialog sits inside the Post form, so an Enter that
	 * reached the form would submit the whole Post while a link was half typed.
	 */
	function onLinkUrlKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Enter') {
			return;
		}
		event.preventDefault();
		applyLink();
	}
</script>

<div class="flex flex-col rounded-md border border-border bg-background">
	<!--
		`flex-wrap`, so that at 390 pixels the seven buttons run onto a second and third line instead of
		widening the form past the screen.
	-->
	<div class="flex flex-wrap gap-1 border-b border-border p-1.5">
		{#each TOOLBAR_ACTIONS as action (action.id)}
			<button
				type="button"
				disabled={!editor}
				aria-pressed={activeActionIds.includes(action.id)}
				onclick={() => runAction(action)}
				class="h-11 rounded-md border border-border bg-background px-2.5 text-xs font-medium hover:bg-muted disabled:opacity-50 aria-pressed:bg-muted aria-pressed:text-foreground md:h-9"
			>
				{action.label()}
			</button>
		{/each}
		<button
			type="button"
			disabled={!editor}
			aria-pressed={linkActive}
			onclick={openLinkDialog}
			class="h-11 rounded-md border border-border bg-background px-2.5 text-xs font-medium hover:bg-muted disabled:opacity-50 aria-pressed:bg-muted aria-pressed:text-foreground md:h-9"
		>
			{m.adminPosts_editorLink()}
		</button>
	</div>

	<div bind:this={host}></div>
</div>

<input type="hidden" {name} value={bodyHtml} />

<!--
	A native `<dialog>`, deliberately, rather than `window.prompt` — which blocks the page and cannot
	be styled or read out sensibly — and rather than a bits-ui `Dialog`, whose content defaults to
	`preventScroll: true` and sets `document.body.style.pointerEvents = "none"` (the trap #138
	recorded). It carries no `<form>` of its own because it is rendered inside the Post form and a
	nested form is not valid HTML; the address field has no `name`, so it is never submitted, and it is
	a plain text field rather than `type="url"` because an unparseable value in a `type="url"` input
	would block the surrounding Post form's own submission through constraint validation.
-->
<dialog
	bind:this={linkDialog}
	aria-labelledby="{id}-link-heading"
	class="m-auto w-[min(24rem,calc(100vw-2rem))] rounded-lg border border-border bg-background p-4 text-foreground backdrop:bg-black/40"
>
	<div class="flex flex-col gap-3">
		<h2 class="text-sm font-semibold" id="{id}-link-heading">
			{m.adminPosts_editorLinkHeading()}
		</h2>

		<label class="text-xs font-medium" for="{id}-link-url">
			{m.adminPosts_editorLinkUrlLabel()}
		</label>
		<input
			id="{id}-link-url"
			type="text"
			inputmode="url"
			bind:value={linkUrl}
			placeholder={m.adminPosts_editorLinkUrlPlaceholder()}
			onkeydown={onLinkUrlKeydown}
			class="h-11 rounded-md border border-border bg-background px-3 text-sm"
		/>

		<div class="flex flex-wrap gap-2">
			<button
				type="button"
				onclick={applyLink}
				class="h-11 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
			>
				{m.adminPosts_editorLinkApply()}
			</button>
			<button
				type="button"
				onclick={removeLink}
				class="h-11 rounded-md border border-border px-3 text-sm font-medium"
			>
				{m.adminPosts_editorLinkRemove()}
			</button>
			<button
				type="button"
				onclick={() => linkDialog?.close()}
				class="h-11 rounded-md border border-border px-3 text-sm font-medium"
			>
				{m.adminPosts_editorLinkCancel()}
			</button>
		</div>
	</div>
</dialog>
