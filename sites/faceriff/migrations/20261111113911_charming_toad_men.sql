CREATE TABLE `cf_daily_dimensions` (
	`day_utc` text NOT NULL,
	`dataset` text NOT NULL,
	`dimension` text NOT NULL,
	`value` text NOT NULL,
	`count` integer NOT NULL,
	`fetched_at` integer NOT NULL,
	`is_partial` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`day_utc`, `dataset`, `dimension`, `value`)
);
--> statement-breakpoint
CREATE TABLE `daily_visitor_dimensions` (
	`day` text NOT NULL,
	`dimension` text NOT NULL,
	`value` text NOT NULL,
	`count` integer NOT NULL,
	PRIMARY KEY(`day`, `dimension`, `value`)
);
