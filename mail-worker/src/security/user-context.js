
const userContext = {
	getUserId(c) {
		return c.get('user').userId;
	},

	getUser(c) {
		return c.get('user');
	},

	async getToken(c) {
		return c.get('session')?.tokenHash;
	},
};
export default userContext;
