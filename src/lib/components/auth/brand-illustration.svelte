<!--
	The picture on the brand panel of the sign-in pages: two houses, two trees and the street in front
	of them, drawn as inline SVG.

	**One file on purpose.** `brand-panel.svelte` renders this component and knows nothing about what
	is in it, so replacing the drawing with a photo of the real complex means rewriting this file alone,
	for example as one `<img>` with an empty `alt` that fills its box with `object-cover`.

	**Colours come from the theme tokens in `src/app.css`, never from a literal.** Every fill and stroke
	is a Tailwind utility over a token (`fill-primary`, `fill-background`, `stroke-foreground/60`), so
	the drawing follows `.dark` exactly the way the rest of the interface does, with no second copy for
	the dark theme and no binary asset to ship.

	The drawing says nothing a reader needs, so it is hidden from assistive technology: the complex name
	and the tagline next to it on the panel carry the meaning.
-->
<svg
	class="h-auto w-full max-w-md"
	viewBox="0 0 480 360"
	xmlns="http://www.w3.org/2000/svg"
	aria-hidden="true"
	focusable="false"
>
	<!-- Sun or moon, depending on the theme. -->
	<circle class="fill-muted-foreground/25" cx="410" cy="60" r="22" />

	<!-- Pavement, street and verge. -->
	<rect class="fill-border" x="0" y="250" width="480" height="26" />
	<rect class="fill-muted-foreground/35" x="0" y="276" width="480" height="56" />
	<line
		class="stroke-background"
		x1="0"
		y1="304"
		x2="480"
		y2="304"
		stroke-width="4"
		stroke-dasharray="24 16"
	/>
	<rect class="fill-border" x="0" y="332" width="480" height="28" />

	<!-- The smaller house, on the left. -->
	<rect
		class="fill-background stroke-foreground/60"
		x="40"
		y="170"
		width="110"
		height="80"
		stroke-width="2"
	/>
	<polygon class="fill-primary" points="30,172 95,115 160,172" />
	<rect class="fill-muted-foreground/40" x="52" y="188" width="22" height="18" rx="2" />
	<rect class="fill-muted-foreground/40" x="116" y="188" width="22" height="18" rx="2" />
	<rect class="fill-primary/80" x="82" y="210" width="26" height="40" rx="2" />

	<!-- A tree between the two houses. -->
	<rect class="fill-chart-4" x="196" y="210" width="8" height="40" />
	<circle class="fill-chart-2" cx="200" cy="192" r="28" />

	<!-- The larger house, chimney first so the roof covers its foot. -->
	<rect class="fill-muted-foreground/60" x="350" y="100" width="16" height="40" />
	<rect
		class="fill-background stroke-foreground/60"
		x="250"
		y="150"
		width="140"
		height="100"
		stroke-width="2"
	/>
	<polygon class="fill-primary" points="238,152 320,90 402,152" />
	<rect class="fill-muted-foreground/40" x="265" y="170" width="28" height="22" rx="2" />
	<rect class="fill-muted-foreground/40" x="347" y="170" width="28" height="22" rx="2" />
	<rect class="fill-primary/80" x="305" y="205" width="30" height="45" rx="2" />

	<!-- A smaller tree on the right edge. -->
	<rect class="fill-chart-4" x="436" y="218" width="8" height="32" />
	<circle class="fill-chart-2" cx="440" cy="202" r="22" />
</svg>
