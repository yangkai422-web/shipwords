CREATE TABLE `analytics_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `daily_visitors` (
	`day` text NOT NULL,
	`visitor_hash` text NOT NULL,
	PRIMARY KEY(`day`, `visitor_hash`)
);
