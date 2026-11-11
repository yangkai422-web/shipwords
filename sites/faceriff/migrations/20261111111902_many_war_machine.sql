CREATE TABLE `cf_daily_traffic` (
	`day_utc` text PRIMARY KEY NOT NULL,
	`uniques` integer NOT NULL,
	`page_views` integer NOT NULL,
	`requests` integer NOT NULL,
	`fetched_at` integer NOT NULL,
	`is_partial` integer DEFAULT false NOT NULL
);
