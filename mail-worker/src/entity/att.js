import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const  att = sqliteTable('attachments', {
	attId: integer('att_id').primaryKey({ autoIncrement: true }),
	generation: text('generation'),
	partId: text('part_id'),
	sha256: text('sha256'),
	storageBackend: text('storage_backend').notNull().default('legacy'),
	storageVersion: text('storage_version').notNull().default('legacy'),
	objectKind: text('object_kind'),
	userId: integer('user_id').notNull(),
	emailId: integer('email_id').notNull(),
	accountId: integer('account_id').notNull(),
	key: text('key').notNull(),
	filename: text('filename'),
	mimeType: text('mime_type'),
	size: integer('size'),
	status: integer('status').default(0).notNull(),
	type: integer('type').default(0).notNull(),
	disposition: text('disposition'),
	related: text('related'),
	contentId: text('content_id'),
	encoding: text('encoding'),
	createTime: text('create_time').default(sql`CURRENT_TIMESTAMP`).notNull(),
});

