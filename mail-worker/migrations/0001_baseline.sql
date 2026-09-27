-- Fresh-install baseline audited against upstream ec7a2bb entities and historical init.
-- Refuse existing tables: legacy adoption requires explicit introspection, never overwrite.
-- Existing UTC text timestamps retained; new reliability/security tables use epoch milliseconds.

CREATE TABLE "user" (
  "user_id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "email" TEXT NOT NULL,
  "type" INTEGER NOT NULL DEFAULT 1,
  "password" TEXT NOT NULL,
  "salt" TEXT NOT NULL,
  "status" INTEGER NOT NULL DEFAULT 0,
  "create_time" TEXT DEFAULT (CURRENT_TIMESTAMP),
  "active_time" TEXT,
  "create_ip" TEXT,
  "active_ip" TEXT,
  "os" TEXT,
  "browser" TEXT,
  "device" TEXT,
  "sort" INTEGER DEFAULT 0,
  "send_count" INTEGER DEFAULT 0,
  "reg_key_id" INTEGER NOT NULL DEFAULT 0,
  "is_del" INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE "account" (
  "account_id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "email" TEXT NOT NULL,
  "name" TEXT NOT NULL DEFAULT '',
  "status" INTEGER NOT NULL DEFAULT 0,
  "latest_email_time" TEXT,
  "create_time" TEXT DEFAULT (CURRENT_TIMESTAMP),
  "user_id" INTEGER NOT NULL,
  "all_receive" INTEGER NOT NULL DEFAULT 0,
  "sort" INTEGER NOT NULL DEFAULT 0,
  "is_del" INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE "email" (
  "email_id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "send_email" TEXT,
  "name" TEXT,
  "account_id" INTEGER NOT NULL,
  "user_id" INTEGER NOT NULL,
  "subject" TEXT,
  "code" TEXT NOT NULL DEFAULT '',
  "text" TEXT,
  "content" TEXT,
  "cc" TEXT DEFAULT '[]',
  "bcc" TEXT DEFAULT '[]',
  "recipient" TEXT,
  "to_email" TEXT NOT NULL DEFAULT '',
  "to_name" TEXT NOT NULL DEFAULT '',
  "in_reply_to" TEXT DEFAULT '',
  "relation" TEXT DEFAULT '',
  "message_id" TEXT DEFAULT '',
  "type" INTEGER NOT NULL DEFAULT 0,
  "status" INTEGER NOT NULL DEFAULT 0,
  "resend_email_id" TEXT,
  "message" TEXT,
  "unread" INTEGER NOT NULL DEFAULT 0,
  "create_time" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "is_del" INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE "attachments" (
  "att_id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "user_id" INTEGER NOT NULL,
  "email_id" INTEGER NOT NULL,
  "account_id" INTEGER NOT NULL,
  "key" TEXT NOT NULL,
  "filename" TEXT,
  "mime_type" TEXT,
  "size" INTEGER,
  "status" INTEGER NOT NULL DEFAULT 0,
  "type" INTEGER NOT NULL DEFAULT 0,
  "disposition" TEXT,
  "related" TEXT,
  "content_id" TEXT,
  "encoding" TEXT,
  "create_time" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE "setting" (
  "register" INTEGER NOT NULL DEFAULT 1,
  "receive" INTEGER NOT NULL DEFAULT 0,
  "title" TEXT NOT NULL DEFAULT '',
  "many_email" INTEGER NOT NULL DEFAULT 0,
  "add_email" INTEGER NOT NULL DEFAULT 0,
  "auto_refresh" INTEGER NOT NULL DEFAULT 0,
  "add_email_verify" INTEGER NOT NULL DEFAULT 1,
  "register_verify" INTEGER NOT NULL DEFAULT 1,
  "reg_verify_count" INTEGER NOT NULL DEFAULT 1,
  "add_verify_count" INTEGER NOT NULL DEFAULT 1,
  "send" INTEGER NOT NULL DEFAULT 1,
  "r2_domain" TEXT,
  "secret_key" TEXT,
  "site_key" TEXT,
  "reg_key" INTEGER NOT NULL DEFAULT 1,
  "background" TEXT,
  "tg_bot_token" TEXT NOT NULL DEFAULT '',
  "tg_chat_id" TEXT NOT NULL DEFAULT '',
  "tg_bot_status" INTEGER NOT NULL DEFAULT 1,
  "forward_email" TEXT NOT NULL DEFAULT '',
  "forward_status" INTEGER NOT NULL DEFAULT 1,
  "rule_email" TEXT NOT NULL DEFAULT '',
  "rule_type" INTEGER NOT NULL DEFAULT 0,
  "login_opacity" INTEGER DEFAULT 0.88,
  "resend_tokens" TEXT NOT NULL DEFAULT '{}',
  "notice_title" TEXT NOT NULL DEFAULT '',
  "notice_content" TEXT NOT NULL DEFAULT '',
  "notice_type" TEXT NOT NULL DEFAULT '',
  "notice_duration" INTEGER NOT NULL DEFAULT 0,
  "notice_position" TEXT NOT NULL DEFAULT '',
  "notice_offset" INTEGER NOT NULL DEFAULT 0,
  "notice_width" INTEGER NOT NULL DEFAULT 400,
  "notice" INTEGER NOT NULL DEFAULT 0,
  "no_recipient" INTEGER NOT NULL DEFAULT 1,
  "login_domain" INTEGER NOT NULL DEFAULT 0,
  "bucket" TEXT NOT NULL DEFAULT '',
  "region" TEXT NOT NULL DEFAULT '',
  "endpoint" TEXT NOT NULL DEFAULT '',
  "s3_access_key" TEXT NOT NULL DEFAULT '',
  "s3_secret_key" TEXT NOT NULL DEFAULT '',
  "force_path_style" INTEGER NOT NULL DEFAULT 1,
  "custom_domain" TEXT NOT NULL DEFAULT '',
  "tg_msg_from" TEXT NOT NULL DEFAULT 'only-name',
  "tg_msg_to" TEXT NOT NULL DEFAULT 'show',
  "tg_msg_text" TEXT NOT NULL DEFAULT 'hide',
  "min_email_prefix" INTEGER NOT NULL DEFAULT 0,
  "email_prefix_filter" TEXT NOT NULL DEFAULT '',
  "black_subject" TEXT NOT NULL DEFAULT '',
  "black_content" TEXT NOT NULL DEFAULT '',
  "black_from" TEXT NOT NULL DEFAULT '',
  "ai_code" INTEGER NOT NULL DEFAULT 1,
  "sync_delete" INTEGER NOT NULL DEFAULT 1,
  "ai_code_filter" TEXT NOT NULL DEFAULT '',
  "linuxdo_client_id" TEXT NOT NULL DEFAULT '',
  "linuxdo_client_secret" TEXT NOT NULL DEFAULT '',
  "linuxdo_switch" INTEGER NOT NULL DEFAULT 1,
  "github_client_id" TEXT NOT NULL DEFAULT '',
  "github_client_secret" TEXT NOT NULL DEFAULT '',
  "github_switch" INTEGER NOT NULL DEFAULT 1,
  "google_client_id" TEXT NOT NULL DEFAULT '',
  "google_client_secret" TEXT NOT NULL DEFAULT '',
  "google_switch" INTEGER NOT NULL DEFAULT 1,
  "auto_clean_days" INTEGER NOT NULL DEFAULT 0,
  "auto_clean_exclude" TEXT NOT NULL DEFAULT '',
  "webhook_url" TEXT NOT NULL DEFAULT '',
  "webhook_status" INTEGER NOT NULL DEFAULT 1,
  "webhook_retry" INTEGER NOT NULL DEFAULT 0,
  "webhook_secret" TEXT NOT NULL DEFAULT ''
);

CREATE TABLE "role" (
  "role_id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "name" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "description" TEXT,
  "ban_email" TEXT NOT NULL DEFAULT '',
  "ban_email_type" INTEGER NOT NULL DEFAULT 0,
  "avail_domain" TEXT DEFAULT '',
  "sort" INTEGER,
  "is_default" INTEGER DEFAULT 0,
  "create_time" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "user_id" INTEGER,
  "send_count" INTEGER,
  "send_type" TEXT DEFAULT 'count',
  "account_count" INTEGER
);

CREATE TABLE "perm" (
  "perm_id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "name" TEXT NOT NULL,
  "perm_key" TEXT,
  "pid" INTEGER NOT NULL DEFAULT 0,
  "type" INTEGER NOT NULL DEFAULT 2,
  "sort" INTEGER
);

CREATE TABLE "role_perm" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "role_id" INTEGER,
  "perm_id" INTEGER
);

CREATE TABLE "star" (
  "star_id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "user_id" INTEGER NOT NULL,
  "email_id" INTEGER NOT NULL,
  "create_time" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE "reg_key" (
  "rege_key_id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "code" TEXT NOT NULL DEFAULT '',
  "count" INTEGER NOT NULL DEFAULT 0,
  "role_id" INTEGER NOT NULL DEFAULT 0,
  "user_id" INTEGER NOT NULL DEFAULT 0,
  "expire_time" TEXT,
  "create_time" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE "verify_record" (
  "vr_id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "ip" TEXT NOT NULL DEFAULT '',
  "count" INTEGER NOT NULL DEFAULT 1,
  "type" INTEGER NOT NULL DEFAULT 0,
  "update_time" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE "oauth" (
  "oauth_id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "oauth_user_id" TEXT,
  "username" TEXT,
  "name" TEXT,
  "avatar" TEXT,
  "active" INTEGER,
  "trust_level" INTEGER,
  "silenced" INTEGER,
  "create_time" TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "platform" INTEGER NOT NULL DEFAULT 0,
  "user_id" INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX idx_user_email_nocase ON user(email COLLATE NOCASE);
CREATE UNIQUE INDEX idx_account_email_nocase ON account(email COLLATE NOCASE);
CREATE UNIQUE INDEX idx_star_user_email ON star(user_id,email_id);
CREATE UNIQUE INDEX idx_reg_key_code ON reg_key(code COLLATE NOCASE);
CREATE INDEX idx_email_list_user ON email(user_id,type,is_del,email_id);
CREATE INDEX idx_email_list_account ON email(user_id,account_id,type,is_del,email_id);
CREATE INDEX idx_email_create_time ON email(create_time);
CREATE INDEX idx_account_user_del_sort ON account(user_id,is_del,sort,account_id);
CREATE INDEX idx_attachments_email_type ON attachments(email_id,type);
CREATE INDEX idx_role_perm_role ON role_perm(role_id);
CREATE INDEX idx_star_email_user ON star(email_id,user_id);
CREATE INDEX idx_user_type ON user(type);
INSERT INTO setting(title,register,send,receive,no_recipient,auto_clean_days,login_domain)
VALUES ('私人邮箱',1,1,0,1,0,1);
INSERT INTO role(role_id,name,key,description,is_default,send_count,send_type,account_count)
VALUES (1,'只收邮件用户','receive-only','私人只收邮箱',1,0,'ban',10),
       (2,'管理员','personal-admin','离线初始化管理员',0,0,'ban',10);
INSERT INTO perm(perm_id,name,perm_key) VALUES (2,'邮件删除','email:delete');
INSERT INTO perm(perm_id,name,perm_key) VALUES (5,'用户注销','my:delete');
INSERT INTO perm(perm_id,name,perm_key) VALUES (7,'用户查看','user:query');
INSERT INTO perm(perm_id,name,perm_key) VALUES (8,'密码修改','user:set-pwd');
INSERT INTO perm(perm_id,name,perm_key) VALUES (9,'状态修改','user:set-status');
INSERT INTO perm(perm_id,name,perm_key) VALUES (10,'权限修改','user:set-type');
INSERT INTO perm(perm_id,name,perm_key) VALUES (11,'用户删除','user:delete');
INSERT INTO perm(perm_id,name,perm_key) VALUES (14,'身份查看','role:query');
INSERT INTO perm(perm_id,name,perm_key) VALUES (15,'身份修改','role:set');
INSERT INTO perm(perm_id,name,perm_key) VALUES (16,'身份删除','role:delete');
INSERT INTO perm(perm_id,name,perm_key) VALUES (18,'设置查看','setting:query');
INSERT INTO perm(perm_id,name,perm_key) VALUES (19,'设置修改','setting:set');
INSERT INTO perm(perm_id,name,perm_key) VALUES (22,'邮箱查看','account:query');
INSERT INTO perm(perm_id,name,perm_key) VALUES (23,'邮箱添加','account:add');
INSERT INTO perm(perm_id,name,perm_key) VALUES (24,'邮箱删除','account:delete');
INSERT INTO perm(perm_id,name,perm_key) VALUES (25,'用户添加','user:add');
INSERT INTO perm(perm_id,name,perm_key) VALUES (28,'全部邮件查看','all-email:query');
INSERT INTO perm(perm_id,name,perm_key) VALUES (29,'全部邮件删除','all-email:delete');
INSERT INTO perm(perm_id,name,perm_key) VALUES (30,'身份添加','role:add');
INSERT INTO role_perm(role_id,perm_id) VALUES (1,2);
INSERT INTO role_perm(role_id,perm_id) VALUES (1,22);
INSERT INTO role_perm(role_id,perm_id) VALUES (1,23);
INSERT INTO role_perm(role_id,perm_id) VALUES (1,24);
INSERT INTO role_perm(role_id,perm_id) SELECT 2,perm_id FROM perm;
