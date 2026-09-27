import {retireAccounts,retireUsers} from './retire-identity.js';
import BizError from '../error/biz-error';
import verifyUtils from '../utils/verify-utils';
import emailUtils from '../utils/email-utils';
import userService from './user-service';
import emailService from './email-service';
import orm from '../entity/orm';
import account from '../entity/account';
import { and, asc, eq, gt, inArray, count, sql, ne, or, lt, desc } from 'drizzle-orm';
import {accountConst, isDel, settingConst} from '../const/entity-const';
import settingService from './setting-service';
import turnstileService from './turnstile-service';
import roleService from './role-service';
import { t } from '../i18n/i18n';
import verifyRecordService from './verify-record-service';

const integer=(value,fallback,min=0)=>{if(value===undefined||value===null)return fallback;if(!/^\d{1,16}$/.test(String(value)))throw new BizError('INVALID_ACCOUNT_PARAMETER',400);const n=Number(value);if(!Number.isSafeInteger(n)||n<min)throw new BizError('INVALID_ACCOUNT_PARAMETER',400);return n;};
const accountIdOf=value=>{const id=integer(value,0,1);if(!id)throw new BizError('INVALID_ACCOUNT_ID',400);return id;};
const accountService = {

	async add(c, params, userId) {

		const { addEmailVerify , addEmail, manyEmail, addVerifyCount, minEmailPrefix, emailPrefixFilter } = await settingService.query(c);

		let { email, token } = params || {};
        if(typeof email!=='string'||email.length>254||email.split('@')[0].length>64)throw new BizError('INVALID_EMAIL',400);
        email=email.toLowerCase();


		if (!(addEmail === settingConst.addEmail.OPEN && manyEmail === settingConst.manyEmail.OPEN)) {
			throw new BizError(t('addAccountDisabled'));
		}


		if (!email) {
			throw new BizError(t('emptyEmail'));
		}

		if (!verifyUtils.isEmail(email)) {
			throw new BizError(t('notEmail'));
		}

		if (!c.env.domain.includes(emailUtils.getDomain(email))) {
			throw new BizError(t('notExistDomain'));
		}

		if (emailUtils.getName(email).length < minEmailPrefix) {
			throw new BizError(t('minEmailPrefix', { msg: minEmailPrefix } ));
		}

		if (emailPrefixFilter.some(content => emailUtils.getName(email).includes(content))) {
			throw new BizError(t('banEmailPrefix'));
		}

		let accountRow = await this.selectByEmailIncludeDel(c, email);

		if (accountRow && accountRow.isDel === isDel.DELETE) {
			throw new BizError(t('isDelAccount'));
		}

		if (accountRow) {
			throw new BizError(t('isRegAccount'));
		}

		if (email.includes('+')) {
			const baseEmail = emailUtils.getBaseEmail(email);
			const baseAccount = await this.selectByEmailIncludeDel(c, baseEmail);
			if (!baseAccount || baseAccount.userId !== userId) {
				throw new BizError(t('notOwner'));
			}
		}

		const userRow = await userService.selectById(c, userId);
		const roleRow = await roleService.selectById(c, userRow.type);

		if (userRow.email !== c.env.admin) {

			if (roleRow.accountCount > 0) {
				const userAccountCount = await accountService.countUserAccount(c, userId)
				if(userAccountCount >= roleRow.accountCount) throw new BizError(t('accountLimit'), 403);
			}

			if(!roleService.hasAvailDomainPerm(roleRow.availDomain, email)) {
				throw new BizError(t('noDomainPermAdd'),403)
			}

		}

		let addVerifyOpen = false

		if (addEmailVerify === settingConst.addEmailVerify.OPEN) {
			addVerifyOpen = true
			await turnstileService.verify(c, token);
		}

		if (addEmailVerify === settingConst.addEmailVerify.COUNT) {
			addVerifyOpen = await verifyRecordService.isOpenAddVerify(c, addVerifyCount);
			if (addVerifyOpen) {
				await turnstileService.verify(c,token)
			}
		}


		const domainRow=await c.env.db.prepare('SELECT domain_id,enabled FROM domains WHERE name=? COLLATE NOCASE').bind(emailUtils.getDomain(email)).first();
		accountRow = await orm(c).insert(account).values({ email: email.toLowerCase(), userId: userId, name: emailUtils.getName(email),domainId:domainRow?.domain_id??null,receiveEnabled:domainRow?.enabled===1?1:0 }).returning().get();
		await c.env.db.prepare("INSERT INTO audit_logs(actor_user_id,action,target_id,result_code,created_at) VALUES(?,'account.created',?,?,unixepoch()*1000)").bind(userId,String(accountRow.accountId),accountRow.receiveEnabled?'ENABLED':'DISABLED').run();

		if (addEmailVerify === settingConst.addEmailVerify.COUNT && !addVerifyOpen) {
			const row = await verifyRecordService.increaseAddCount(c);
			addVerifyOpen = row.count >= addVerifyCount
		}

		accountRow.addVerifyOpen = addVerifyOpen
		return accountRow;
	},

	selectByEmailIncludeDel(c, email) {
		return orm(c).select().from(account).where(sql`${account.email} COLLATE NOCASE = ${email}`).get();
	},

	selectLoginAccount(c, userId, email) {
		return orm(c).select().from(account)
			.where(and(eq(account.userId, userId), eq(account.isDel, 0)))
			.orderBy(sql`CASE WHEN ${account.email} COLLATE NOCASE = ${email} THEN 0 ELSE 1 END`, account.accountId).limit(1).get();
	},

	list(c, params, userId) {

        const accountId=integer(params?.accountId,0),size=Math.min(30,integer(params?.size,30,1)),lastSort=integer(params?.lastSort,Number.MAX_SAFE_INTEGER);

		return orm(c).select().from(account).where(
			and(
				eq(account.userId, userId),
				eq(account.isDel, isDel.NORMAL),
					or(
						lt(account.sort, lastSort),
						and(
							eq(account.sort, lastSort),
							gt(account.accountId, accountId)
						)
					))
				)
			.orderBy(desc(account.sort), asc(account.accountId))
			.limit(size)
			.all();
	},

	async delete(c, params, userId) {

		const accountId = accountIdOf(params?.accountId);

		const user = await userService.selectById(c, userId);
		const accountRow = await this.selectById(c, accountId);

		if (!accountRow || accountRow.userId !== userId) throw new BizError('NOT_FOUND',404);
		if (accountRow.email === user.email) {
			throw new BizError(t('delMyAccount'));
		}

		if (accountRow.userId !== user.userId) {
			throw new BizError(t('noUserAccount'));
		}

		await retireAccounts(c.env.db,[accountId],userId,true);
	},

	selectById(c, accountId) {
		return orm(c).select().from(account).where(
			and(eq(account.accountId, accountId),
				eq(account.isDel, isDel.NORMAL)))
			.get();
	},

	async insert(c, params) {
		await orm(c).insert(account).values({ ...params }).returning();
	},

	async insertList(c, list) {
		await orm(c).insert(account).values(list).run();
	},

	async physicsDeleteByUserIds(c, userIds) {
		return retireUsers(c.env.db,userIds,c.get('user').userId);
	},

	async selectUserAccountCountList(c, userIds, del = isDel.NORMAL) {
		const result = await orm(c)
			.select({
				userId: account.userId,
				count: count(account.accountId)
			})
			.from(account)
			.where(and(
				inArray(account.userId, userIds),
				eq(account.isDel, del)
			))
			.groupBy(account.userId)
		return result;
	},

	async countUserAccount(c, userId) {
		const { num } = await orm(c).select({num: count()}).from(account).where(and(eq(account.userId, userId),eq(account.isDel, isDel.NORMAL))).get();
		return num;
	},

	async restoreByEmail(c, email) {
		await orm(c).update(account).set({isDel: isDel.NORMAL}).where(and(eq(account.email, email),sql`${account.retiredAt} IS NULL`)).run();
	},

	async restoreByUserId(c, userId) {
		await orm(c).update(account).set({isDel: isDel.NORMAL}).where(and(eq(account.userId, userId),sql`${account.retiredAt} IS NULL`)).run();
	},

	async setName(c, params, userId) {
		const {name}=params||{};const accountId=accountIdOf(params?.accountId);
        if(typeof name!=='string')throw new BizError('INVALID_NAME',400);
        const owned=await this.selectById(c,accountId);if(!owned||owned.userId!==userId)throw new BizError('NOT_FOUND',404);
		if (name.length > 30) {
			throw new BizError(t('usernameLengthLimit'));
		}
		await orm(c).update(account).set({name}).where(and(eq(account.userId, userId),eq(account.accountId, accountId))).run();
	},

	async allAccount(c, params) {

        const userId=accountIdOf(params?.userId),size=Math.min(30,integer(params?.size,30,1));
        const num=(integer(params?.num,1,1)-1)*size;
        if(!Number.isSafeInteger(num))throw new BizError('INVALID_PAGE',400);

		const userRow = await userService.selectByIdIncludeDel(c, userId);

		if(!userRow)throw new BizError('NOT_FOUND',404);
		const list = await orm(c).select().from(account).where(and(eq(account.userId, userId),ne(account.email,userRow.email))).limit(size).offset(num);
		const { total } = await orm(c).select({ total: count() }).from(account).where(and(eq(account.userId,userId),ne(account.email,userRow.email))).get();

		return { list, total }
	},

	async physicsDelete(c, params) {
		return retireAccounts(c.env.db,[params.accountId],c.get('user').userId);
	},

	async setAllReceive(c, params, userId) {
        const accountId=accountIdOf(params?.accountId);
        const accountRow=await this.selectById(c,accountId);
        if(!accountRow||accountRow.userId!==userId)throw new BizError('NOT_FOUND',404);

        await c.env.db.prepare('UPDATE account SET all_receive=CASE WHEN account_id=? THEN ? ELSE 0 END WHERE user_id=?')
          .bind(accountId,accountRow.allReceive?0:1,userId).run();
	},

	async setAsTop(c, params, userId) {
        const accountId=accountIdOf(params?.accountId);
        const updated=await c.env.db.prepare(`UPDATE account SET sort=(SELECT coalesce(max(sort),0)+1 FROM account WHERE user_id=? AND is_del=0)
          WHERE account_id=? AND user_id=? AND is_del=0 RETURNING account_id`).bind(userId,accountId,userId).first();
        if(!updated)throw new BizError('NOT_FOUND',404);
	}
};

export default accountService;
