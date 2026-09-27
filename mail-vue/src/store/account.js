    import { defineStore } from 'pinia'

export const useAccountStore = defineStore('account', {
    state: () => ({
        currentAccountId: 0,
        currentAccount: {},
        changeUserAccountName: '',
        allMailboxes: false,
        revision: 0,
        pinnedByUser: {},
        selectionByUser: {},
        orderByUser: {},
    }),
    persist: {pick: ['pinnedByUser', 'selectionByUser', 'orderByUser']},
})
