import {retireUsers} from './retire-identity.js';
import BizError from '../error/biz-error';
import accountService from './account-service';
import orm from '../entity/orm';
import user from '../entity/user';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { emailConst, isDel, roleConst, settingConst, userConst } from '../const/entity-const';
import kvConst from '../const/kv-const';
import KvConst from '../const/kv-const';
import cryptoUtils, { validPassword } from '../utils/crypto-utils';
import { userAuditStatement } from '../security/audit.js';
import { receiveOnlyPermissions } from '../security/receive-only.js';
import emailService from './email-service';
import dayjs from 'dayjs';
import permService from './perm-service';
import roleService from './role-service';
import emailUtils from '../utils/email-utils';
import saltHashUtils from '../utils/crypto-utils';
import constant from '../const/constant';
import { t } from '../i18n/i18n'
import reqUtils from '../utils/req-utils';
import {oauth} from "../entity/oauth";
import oauthService from "./oauth-service";
import settingService from './setting-service';
import starService from './star-service';
import verifyUtils from '../utils/verify-utils';

const managementUserFields = {
	userId: user.userId, email: user.email, type: user.type, status: user.status,
	createTime: user.createTime, activeTime: user.activeTime, createIp: user.createIp,
	activeIp: user.activeIp, os: user.os, browser: user.browser, device: user.device,
	sort: user.sort, sendCount: user.sendCount, regKeyId: user.regKeyId,
	isDel: user.isDel, retiredAt: user.retiredAt, retiredThrough: user.retiredThrough,
};

const userService = {

	async loginUserInfo(c, userId) {

		const userRow = await userService.selectById(c, userId);

		if (!userRow) {
			throw new BizError(t('authExpired'), 401);
		}

		const isAdmin = typeof c.env.admin === 'string' && userRow.email.toLowerCase() === c.env.admin.toLowerCase();
		const [account, roleRow, permKeys] = await Promise.all([
			accountService.selectLoginAccount(c, userId, userRow.email),
			roleService.selectById(c, userRow.type),
			isAdmin ? Promise.resolve(['*']) : permService.userPermKeys(c, userId)
		]);

		const user = {};
		user.userId = userRow.userId;
		user.sendCount = userRow.sendCount;
		user.email = userRow.email;
		user.account = account ?? null;
		user.name = account?.name || userRow.email;
		user.permKeys = receiveOnlyPermissions(permKeys);
		user.role = roleRow;
		user.type = userRow.type;

		if (isAdmin) {
			user.role = constant.ADMIN_ROLE
			user.type = 0;
		}

		return user;
	},


	async resetPassword(c, params, userId) {

		const password = params?.password;

		if (!validPassword(password)) {
			throw new BizError('PASSWORD_POLICY_REQUIRES_12_CHARS_MAX_1024_BYTES', 400);
		}
		const actorUserId = c.get?.('user')?.userId;
		if (!Number.isSafeInteger(actorUserId) || actorUserId < 1) throw new BizError('SESSION_REQUIRED', 401);
		const targetId = Number(userId);
		if (!Number.isSafeInteger(targetId) || targetId < 1) throw new BizError('INVALID_USER_ID', 400);
		const { salt, hash } = await cryptoUtils.hashPassword(password);
		const results = await c.env.db.batch([
			c.env.db.prepare('UPDATE user SET password=?,salt=? WHERE user_id=? AND is_del=0').bind(hash, salt, targetId),
			userAuditStatement(c.env.db, { action: 'auth.password.changed', code: 'SUCCESS', actorUserId, targetId }),
			c.env.db.prepare(`UPDATE sessions SET revoked_at=? WHERE revoked_at IS NULL AND user_id=?
				AND EXISTS (SELECT 1 FROM user WHERE user_id=? AND is_del=0)`).bind(Date.now(), targetId, targetId),
		]);
		if (results[0].meta.changes !== 1) throw new BizError('NOT_FOUND', 404);
	},

	selectByEmail(c, email) {
		return orm(c).select().from(user).where(
			and(
				sql`${user.email} COLLATE NOCASE = ${email}`,
				eq(user.isDel, isDel.NORMAL)))
			.get();
	},

	async insert(c, params) {
		const { userId } = await orm(c).insert(user).values({ ...params }).returning().get();
		return userId;
	},

	selectByEmailIncludeDel(c, email) {
		return orm(c).select().from(user).where(sql`${user.email} COLLATE NOCASE = ${email}`).get();
	},

	selectByIdIncludeDel(c, userId) {
		return orm(c).select().from(user).where(eq(user.userId, userId)).get();
	},

	selectById(c, userId) {
		return orm(c).select().from(user).where(
			and(
				eq(user.userId, userId),
				eq(user.isDel, isDel.NORMAL)))
			.get();
	},

	async delete(c, userId) {
		return retireUsers(c.env.db,[userId],userId);
	},

	async physicsDelete(c, params) {
		return retireUsers(c.env.db,params.userIds,c.get('user').userId);
	},

	async list(c, params) {

		let { num, size, email, timeSort, status } = params;

		size = size === undefined ? 50 : Number(size);
		num = num === undefined ? 1 : Number(num);
		if (!Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(num) || num < 1) {
			throw new BizError('INVALID_PAGE', 400);
		}
		timeSort = Number(timeSort);
		params.isDel = Number(params.isDel);

		if (size > 50) {
			size = 50;
		}

		num = (num - 1) * size;
		if (!Number.isSafeInteger(num)) throw new BizError('INVALID_PAGE', 400);

		const conditions = [];

		if (status > -1) {
			conditions.push(eq(user.status, status));
			conditions.push(eq(user.isDel, isDel.NORMAL));
		}


		if (email) {
			conditions.push(sql`${user.email} COLLATE NOCASE LIKE ${email + '%'}`);
		}


		if (params.isDel) {
			conditions.push(eq(user.isDel, params.isDel));
		}


		const query = orm(c).select({
			...managementUserFields,
			username: oauth.username,
			trustLevel: oauth.trustLevel,
			avatar: oauth.avatar,
			name: oauth.name,
			platform: oauth.platform
		}).from(user).leftJoin(oauth, eq(oauth.userId, user.userId))
			.where(and(...conditions));


		if (timeSort) {
			query.orderBy(asc(user.userId));
		} else {
			query.orderBy(desc(user.userId));
		}

		const list = await query.limit(size).offset(num);

		const { total } = await orm(c)
			.select({ total: count() })
			.from(user)
			.where(and(...conditions)).get();
		const userIds = list.map(user => user.userId);

		const types = [...new Set(list.map(user => user.type))];

		const [emailCounts, delEmailCounts, sendCounts, delSendCounts, accountCounts, delAccountCounts, roleList] = await Promise.all([
			emailService.selectUserEmailCountList(c, userIds, emailConst.type.RECEIVE),
			emailService.selectUserEmailCountList(c, userIds, emailConst.type.RECEIVE, isDel.DELETE),
			emailService.selectUserEmailCountList(c, userIds, emailConst.type.SEND),
			emailService.selectUserEmailCountList(c, userIds, emailConst.type.SEND, isDel.DELETE),
			accountService.selectUserAccountCountList(c, userIds),
			accountService.selectUserAccountCountList(c, userIds, isDel.DELETE),
			roleService.selectByIdsHasPermKey(c, types,'email:send')
		]);

		const receiveMap = Object.fromEntries(emailCounts.map(item => [item.userId, item.count]));
		const sendMap = Object.fromEntries(sendCounts.map(item => [item.userId, item.count]));
		const accountMap = Object.fromEntries(accountCounts.map(item => [item.userId, item.count]));

		const delReceiveMap = Object.fromEntries(delEmailCounts.map(item => [item.userId, item.count]));
		const delSendMap = Object.fromEntries(delSendCounts.map(item => [item.userId, item.count]));
		const delAccountMap = Object.fromEntries(delAccountCounts.map(item => [item.userId, item.count]));

		for (const user of list) {

			const userId = user.userId;

			user.receiveEmailCount = receiveMap[userId] || 0;
			user.sendEmailCount = sendMap[userId] || 0;
			user.accountCount = accountMap[userId] || 0;

			user.delReceiveEmailCount = delReceiveMap[userId] || 0;
			user.delSendEmailCount = delSendMap[userId] || 0;
			user.delAccountCount = delAccountMap[userId] || 0;

			const roleIndex = roleList.findIndex(roleRow => user.type === roleRow.roleId);
			let sendAction = {};

			if (roleIndex > -1) {
				sendAction.sendType = roleList[roleIndex].sendType;
				sendAction.sendCount = roleList[roleIndex].sendCount;
				sendAction.hasPerm = true;
			} else {
				sendAction.hasPerm = false;
			}

			if (user.email === c.env.admin) {
				sendAction.sendType = constant.ADMIN_ROLE.sendType;
				sendAction.sendCount = constant.ADMIN_ROLE.sendCount;
				sendAction.hasPerm = true;
				user.type = 0
			}

			user.sendAction = sendAction;
		}

		return { list, total };
	},

	async updateUserInfo(c, userId, recordCreateIp = false) {



		const activeIp = reqUtils.getIp(c);

		const {os, browser, device} = reqUtils.getUserAgent(c);

		const params = {
			os,
			browser,
			device,
			activeIp,
			activeTime: dayjs().format('YYYY-MM-DD HH:mm:ss')
		};

		if (recordCreateIp) {
			params.createIp = activeIp;
		}

		await orm(c)
			.update(user)
			.set(params)
			.where(eq(user.userId, userId))
			.run();
	},

	async setPwd(c, params) {

		const { password, userId } = params;
		await this.resetPassword(c, { password }, userId);
		await c.env.kv.delete(KvConst.AUTH_INFO + userId);
	},

	async setStatus(c, params) {

		const { status, userId } = params;
		if(![0,1].includes(status)||!Number.isSafeInteger(Number(userId))||Number(userId)<1)throw new BizError('INVALID_USER_STATUS',400);
		const updated=await c.env.db.batch([
			c.env.db.prepare('UPDATE user SET status=? WHERE user_id=? AND retired_at IS NULL RETURNING user_id').bind(status,Number(userId)),
			c.env.db.prepare("INSERT INTO audit_logs(actor_user_id,action,target_id,result_code,created_at) SELECT ?,'user.status',?, ?,unixepoch()*1000 WHERE changes()=1").bind(c.get('user').userId,String(userId),status?'DISABLED':'ENABLED'),
			c.env.db.prepare('UPDATE sessions SET revoked_at=unixepoch()*1000 WHERE user_id=? AND revoked_at IS NULL').bind(Number(userId)),
		]);
		if(!updated[0].results.length)throw new BizError('USER_UNAVAILABLE',409);
		return;

	},

	async setType(c, params) {

		const { type, userId } = params;

		const roleRow = await roleService.selectById(c, type);

		if (!roleRow) {
			throw new BizError(t('roleNotExist'));
		}

		await orm(c)
			.update(user)
			.set({ type })
			.where(eq(user.userId, userId))
			.run();

	},

	async incrUserSendCount(c, quantity, userId) {
		await orm(c).update(user).set({
			sendCount: sql`${user.sendCount}
	  +
	  ${quantity}`
		}).where(eq(user.userId, userId)).run();
	},

	async updateAllUserType(c, type, curType) {
		await orm(c)
			.update(user)
			.set({ type })
			.where(eq(user.type, curType))
			.run();
	},

	async add(c, params) {

		let { email, type, password } = params || {};
		if (typeof email !== 'string' || email.length > 254 || !verifyUtils.isEmail(email)
			|| emailUtils.getName(email).length > 64) throw new BizError('INVALID_EMAIL', 400);
		if (!validPassword(password)) {
			throw new BizError('PASSWORD_POLICY_REQUIRES_12_CHARS_MAX_1024_BYTES', 400);
		}

		email = email.toLowerCase();
		if (!c.env.domain.includes(emailUtils.getDomain(email))) {
			throw new BizError(t('notEmailDomain'));
		}

		const accountRow = await accountService.selectByEmailIncludeDel(c, email);

		if (accountRow && accountRow.isDel === isDel.DELETE) {
			throw new BizError(t('isDelUser'));
		}

		if (accountRow) {
			throw new BizError(t('isRegAccount'));
		}

		let role;
		if (type === undefined) {
			role = await roleService.selectDefaultRole(c);
			type = role?.roleId;
		} else {
			role = await roleService.selectById(c, type);
		}

		if (!role) {
			throw new BizError(t('roleNotExist'));
		}

		const { salt, hash } = await saltHashUtils.hashPassword(password);

		const ip = reqUtils.getIp(c), { os, browser, device } = reqUtils.getUserAgent(c);
		await c.env.db.batch([
			c.env.db.prepare('INSERT INTO user(email,password,salt,type,create_ip,active_ip,os,browser,device,active_time) VALUES(?,?,?,?,?,?,?,?,?,?)')
				.bind(email,hash,salt,type,ip,ip,os,browser,device,dayjs().format('YYYY-MM-DD HH:mm:ss')),
			c.env.db.prepare(`INSERT INTO account(user_id,email,name,domain_id,receive_enabled)
				SELECT u.user_id,u.email,?,d.domain_id,CASE WHEN d.enabled=1 THEN 1 ELSE 0 END
				FROM user u LEFT JOIN domains d ON d.name=? COLLATE NOCASE WHERE u.email=? COLLATE NOCASE`)
				.bind(emailUtils.getName(email),emailUtils.getDomain(email),email),
		]);
	},

	async resetDaySendCount(c) {
		// 仅 UTC 0 点执行，便于配合每小时 cron
		if (new Date().getUTCHours() !== 0) {
			return;
		}
		const roleList = await roleService.selectByIdsAndSendType(c, 'email:send', roleConst.sendType.DAY);
		const roleIds = roleList.map(action => action.roleId);
		await orm(c).update(user).set({ sendCount: 0 }).where(inArray(user.type, roleIds)).run();
	},

	async resetSendCount(c, params) {
		await orm(c).update(user).set({ sendCount: 0 }).where(eq(user.userId, params.userId)).run();
	},

	async restore(c, params) {
		const { userId, type } = params
		const retired=await c.env.db.prepare('SELECT retired_at FROM user WHERE user_id=?').bind(userId).first();
		if (retired?.retired_at != null) {
			const restored=await c.env.db.batch([
				c.env.db.prepare(`UPDATE user SET is_del=0,status=1,retired_at=NULL WHERE user_id=? AND retired_at IS NOT NULL
				  AND NOT EXISTS(SELECT 1 FROM email e WHERE e.user_id=user.user_id AND e.delete_state='ACTIVE')
				  AND NOT EXISTS(SELECT 1 FROM mail_processing p WHERE p.user_id=user.user_id AND NOT EXISTS(SELECT 1 FROM mail_tombstones t WHERE t.delivery_id=p.delivery_id)) RETURNING user_id`).bind(userId),
				c.env.db.prepare("INSERT INTO audit_logs(actor_user_id,action,target_id,result_code,created_at) SELECT ?,'user.restored',?,'DISABLED',unixepoch()*1000 WHERE changes()=1").bind(c.get('user').userId,String(userId)),
			]);
			if(!restored[0].results.length)throw new BizError('RETIREMENT_CLEANUP_PENDING',409);
			return;
		}
		await orm(c)
			.update(user)
			.set({ isDel: isDel.NORMAL })
			.where(eq(user.userId, userId))
			.run();
		const userRow = await this.selectById(c, userId);
		await accountService.restoreByEmail(c, userRow.email);

		if (type) {
			await emailService.restoreByUserId(c, userId);
			await accountService.restoreByUserId(c, userId);
		}

	},

	listByRegKeyId(c, regKeyId) {
		return orm(c)
			.select({email: user.email,createTime: user.createTime})
			.from(user)
			.where(eq(user.regKeyId, regKeyId))
			.orderBy(desc(user.userId))
			.all();
	}
};

export default userService;
