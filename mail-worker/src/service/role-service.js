import role from '../entity/role';
import orm from '../entity/orm';
import { eq, asc, inArray, and, sql } from 'drizzle-orm';
import BizError from '../error/biz-error';
import rolePerm from '../entity/role-perm';
import perm from '../entity/perm';
import { permConst, roleConst } from '../const/entity-const';
import user from '../entity/user';
import verifyUtils from '../utils/verify-utils';
import { t } from '../i18n/i18n.js';
import emailUtils from '../utils/email-utils';

function roleInput(params) {
	if (!params || typeof params.name !== 'string' || !params.name.trim()
		|| !Array.isArray(params.permIds) || params.permIds.length > 1000
		|| params.permIds.some(id => !Number.isSafeInteger(id) || id < 1)
		|| !Array.isArray(params.banEmail) || !Array.isArray(params.availDomain)
		|| params.banEmail.some(item => typeof item !== 'string' || (!verifyUtils.isEmail(item) && !verifyUtils.isDomain(item) && item !== '*'))
		|| params.availDomain.some(item => typeof item !== 'string' || !verifyUtils.isDomain(item))) throw new BizError('INVALID_ROLE', 400);
	const values = { name: params.name, banEmail: params.banEmail.join(','), availDomain: params.availDomain.join(',') };
	for (const key of ['description', 'banEmailType', 'sort', 'sendCount', 'sendType', 'accountCount']) {
		if (params[key] !== undefined) values[key] = params[key];
	}
	return { values, permIds: [...new Set(params.permIds)] };
}
const roleIdOf = value => {
	const id = Number(value);
	if (!Number.isSafeInteger(id) || id < 1) throw new BizError('INVALID_ROLE_ID', 400);
	return id;
};

const roleService = {

	async add(c, params, userId) {
		const { values, permIds } = roleInput(params), key = crypto.randomUUID(), db = orm(c);
		const statements = [db.insert(role).values({ ...values, key, userId })];
		if (permIds.length) statements.push(db.insert(rolePerm).values(permIds.map(permId => ({
			permId, roleId: sql`(SELECT role_id FROM role WHERE key=${key})`,
		}))));
		await db.batch(statements);
	},

	async roleList(c) {

		const roleList = await orm(c).select().from(role).orderBy(asc(role.sort)).all();
		const permList = await orm(c).select({ permId: perm.permId, roleId: rolePerm.roleId }).from(rolePerm)
			.leftJoin(perm, eq(perm.permId, rolePerm.permId))
			.where(eq(perm.type, permConst.type.BUTTON)).all();

		roleList.forEach(role => {
			role.banEmail = role.banEmail.split(",").filter(item => item !== "");
			role.availDomain = role.availDomain.split(",").filter(item => item !== "");
			role.permIds = permList.filter(perm => perm.roleId === role.roleId).map(perm => perm.permId);
		});

		return roleList;
	},

	async setRole(c, params) {
		const { values, permIds } = roleInput(params), roleId = roleIdOf(params.roleId), db = orm(c);
		if (!await this.selectById(c, roleId)) throw new BizError('NOT_FOUND', 404);
		const statements = [db.update(role).set(values).where(eq(role.roleId, roleId)),
			db.delete(rolePerm).where(eq(rolePerm.roleId, roleId))];
		if (permIds.length) statements.push(db.insert(rolePerm).values(permIds.map(permId => ({ permId, roleId }))));
		await db.batch(statements);
	},

	async delete(c, params) {

		const { roleId } = params;

		const roleRow = await orm(c).select().from(role).where(eq(role.roleId, roleId)).get();

		if (!roleRow) {
			throw new BizError(t('notExist'));
		}

		if (roleRow.isDefault) {
			throw new BizError(t('delDefRole'));
		}

		const defRoleRow = await orm(c).select().from(role).where(eq(role.isDefault, roleConst.isDefault.OPEN)).get();

		if (!defRoleRow) throw new BizError('DEFAULT_ROLE_REQUIRED', 409);
		await c.env.db.batch([
			c.env.db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM role WHERE role_id=? AND is_default=0) AND EXISTS(SELECT 1 FROM role WHERE role_id=? AND is_default=1) THEN 1 ELSE json('ROLE_STATE_CHANGED') END").bind(roleId,defRoleRow.roleId),
			c.env.db.prepare('UPDATE user SET type=? WHERE type=?').bind(defRoleRow.roleId,roleId),
			c.env.db.prepare('DELETE FROM role_perm WHERE role_id=?').bind(roleId),
			c.env.db.prepare('DELETE FROM role WHERE role_id=?').bind(roleId),
		]);

	},

	roleSelectUse(c) {
		return orm(c).select({ name: role.name, roleId: role.roleId, isDefault: role.isDefault }).from(role).orderBy(asc(role.sort)).all();
	},

	async selectDefaultRole(c) {
		return await orm(c).select().from(role).where(eq(role.isDefault, roleConst.isDefault.OPEN)).get();
	},

	async setDefault(c, params) {
		const roleId = roleIdOf(params?.roleId);
		const result = await c.env.db.prepare('UPDATE role SET is_default=CASE WHEN role_id=? THEN 1 ELSE 0 END WHERE EXISTS(SELECT 1 FROM role WHERE role_id=?)')
			.bind(roleId, roleId).run();
		if (!result.meta.changes) throw new BizError('NOT_FOUND', 404);
	},

	selectById(c, roleId) {
		return orm(c).select().from(role).where(eq(role.roleId, roleId)).get();
	},

	selectByIdsHasPermKey(c, types, permKey) {
		return orm(c).select({ roleId: role.roleId, sendType: role.sendType, sendCount: role.sendCount }).from(perm)
			.leftJoin(rolePerm, eq(perm.permId, rolePerm.permId))
			.leftJoin(role, eq(role.roleId, rolePerm.roleId))
			.where(and(eq(perm.permKey, permKey), inArray(role.roleId, types))).all();
	},

	selectByIdsAndSendType(c, permKey, sendType) {
		return orm(c).select({ roleId: role.roleId }).from(perm)
			.leftJoin(rolePerm, eq(perm.permId, rolePerm.permId))
			.leftJoin(role, eq(role.roleId, rolePerm.roleId))
			.where(and(eq(perm.permKey, permKey), eq(role.sendType, sendType))).all();
	},

	selectByUserId(c, userId) {
		return orm(c).select(role).from(user).leftJoin(role, eq(role.roleId, user.type)).where(eq(user.userId, userId)).get();
	},

	hasAvailDomainPerm(availDomain, email) {

		availDomain = availDomain.split(',').filter(item => item !== '');

		if (availDomain.length === 0) {
			return true
		}

		const availIndex = availDomain.findIndex(item => {
			const domain = emailUtils.getDomain(email.toLowerCase());
			const availDomainItem = item.toLowerCase();
			return domain === availDomainItem
		})

		return availIndex > -1
	},

	selectByName(c, roleName) {
		return orm(c).select().from(role).where(eq(role.name, roleName)).get();
	},

	selectByUserIds(c, userIds) {

		if (!userIds || userIds.length === 0) {
			return [];
		}

		return orm(c).select({ ...role, userId: user.userId }).from(user).leftJoin(role, eq(role.roleId, user.type)).where(inArray(user.userId, userIds)).all();

	},

	isBanEmail(banEmail, fromEmail) {

		banEmail = banEmail.split(',').filter(item => item !== '');

		if (banEmail.includes('*')) {
			return true;
		}

		for (const item of banEmail) {

			if (verifyUtils.isDomain(item)) {

				const banDomain = item.toLowerCase();
				const receiveDomain = emailUtils.getDomain(fromEmail.toLowerCase());

				if (banDomain === receiveDomain) {
					return true;
				}

			} else {

				if (item.toLowerCase() === fromEmail.toLowerCase()) {

					return true;

				}

			}

		}

		return false;
	}
};

export default roleService;
