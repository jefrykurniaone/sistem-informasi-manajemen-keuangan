CREATE TABLE "percobaan_rangka" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"keterangan" text NOT NULL,
	"nilai" bigint NOT NULL,
	"dibuat_pada" timestamp with time zone DEFAULT now() NOT NULL
);
