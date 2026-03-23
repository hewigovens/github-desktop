import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert'
import { Account } from '../../src/models/account'
import { AccountsStore } from '../../src/lib/stores'
import { getKeyForAccount } from '../../src/lib/auth'
import { InMemoryStore, AsyncInMemoryStore } from '../helpers/stores'
import { TokenRefreshEvent } from '../../src/lib/credential-sessions'
import { OAuthRefreshRejectedError } from '../../src/lib/oauth-token'

describe('AccountsStore', () => {
  let accountsStore: AccountsStore

  beforeEach(() => {
    accountsStore = new AccountsStore(
      new InMemoryStore(),
      new AsyncInMemoryStore()
    )
  })

  describe('adding a new user', () => {
    it('contains the added user', async () => {
      const newAccountLogin = 'joan'
      await accountsStore.addAccount(
        new Account(newAccountLogin, '', 'deadbeef', [], '', 1, '', 'free')
      )

      const users = await accountsStore.getAll()
      assert.equal(users[0].login, newAccountLogin)
    })
  })

  it('publishes credential-free renewal events and supports unsubscribing', async t => {
    const account = new Account(
      'octocat',
      'https://api.github.com',
      'old-access',
      [],
      '',
      1,
      'Octocat'
    )
    const store = new AccountsStore(
      new InMemoryStore(),
      new AsyncInMemoryStore(),
      async () => ({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresAt: Date.now() + 8 * 60 * 60_000,
      })
    )
    await store.addAccount(account, {
      accessToken: account.token,
      refreshToken: 'old-refresh',
      expiresAt: 0,
    })
    const events: TokenRefreshEvent[] = []
    const subscription = store.onTokenRefreshEvent(event => events.push(event))
    t.after(() => subscription.dispose())
    await store.getAccountWithFreshToken(account)
    assert.deepEqual(events, ['attempt', 'success'])
    subscription.dispose()
    await store.addAccount(account, {
      accessToken: account.token,
      refreshToken: 'another-refresh',
      expiresAt: 0,
    })
    await store.getAccountWithFreshToken(account)
    assert.deepEqual(events, ['attempt', 'success'])
  })

  it('counts actual renewal sign-outs even if deleting secure storage fails', async t => {
    const secure = new AsyncInMemoryStore()
    const store = new AccountsStore(new InMemoryStore(), secure, async () => {
      throw new OAuthRefreshRejectedError()
    })
    const account = new Account(
      'octocat',
      'https://api.github.com',
      'old-access',
      [],
      '',
      1,
      'Octocat'
    )
    await store.addAccount(account, {
      accessToken: account.token,
      refreshToken: 'old-refresh',
      expiresAt: 0,
    })
    const events: TokenRefreshEvent[] = []
    const subscription = store.onTokenRefreshEvent(event => events.push(event))
    t.after(() => subscription.dispose())
    const deletion = t.mock.method(secure, 'deleteItem', async () => {
      throw new Error('Secure deletion failed')
    })
    await assert.rejects(
      store.getAccountWithFreshToken(account),
      OAuthRefreshRejectedError
    )
    assert.equal(deletion.mock.callCount(), 1)
    assert.deepEqual(await store.getAll(), [])
    assert.deepEqual(events, [
      'attempt',
      'non-transient-failure',
      'required-sign-in',
    ])
  })

  it('edits expiry without publishing an account change or triggering renewal', async t => {
    const previousPreview = process.env.GITHUB_DESKTOP_PREVIEW_FEATURES
    process.env.GITHUB_DESKTOP_PREVIEW_FEATURES = '1'
    t.after(() => {
      if (previousPreview === undefined) {
        delete process.env.GITHUB_DESKTOP_PREVIEW_FEATURES
      } else {
        process.env.GITHUB_DESKTOP_PREVIEW_FEATURES = previousPreview
      }
    })
    const now = Date.now()
    const account = new Account(
      'octocat',
      'https://api.github.com',
      'test-access',
      [],
      '',
      1,
      'Octocat'
    )
    await accountsStore.addAccount(account, {
      accessToken: account.token,
      refreshToken: 'test-refresh',
      expiresAt: now + 8 * 60 * 60_000,
    })
    const [current] = await accountsStore.getAll()
    assert.ok(current)
    const getter = accountsStore.createTokenGetter(current, 0)
    let updates = 0
    const subscription = accountsStore.onDidUpdate(() => {
      updates++
    })
    t.after(() => subscription.dispose())

    await accountsStore.setTokenExpirationForTesting(current, now + 5 * 60_000)
    assert.equal((await getter()).expiresAt, now + 5 * 60_000)
    assert.equal(
      (await accountsStore.getTokenExpirationForTesting(current)).isOverridden,
      true
    )
    await accountsStore.setTokenExpirationForTesting(current, undefined)
    assert.equal((await getter()).expiresAt, now + 8 * 60 * 60_000)
    assert.equal(updates, 0)
    assert.equal((await accountsStore.getAll())[0], current)
  })

  describe('loading persisted users', () => {
    it('migrates .ghe.com users still using /api/v3 to api. subdomain', async () => {
      const dataStore = new InMemoryStore()
      dataStore.setItem(
        'users',
        JSON.stringify([
          {
            login: 'joan',
            endpoint: 'https://whatever.ghe.com/api/v3',
            token: 'deadbeef',
            emails: [],
            avatarURL: '',
            id: 1,
            name: '',
            plan: 'free',
          },
        ])
      )
      accountsStore = new AccountsStore(dataStore, new AsyncInMemoryStore())

      const users = await accountsStore.getAll()
      assert.equal(users[0].login, 'joan')
      assert.equal(users[0].endpoint, 'https://api.whatever.ghe.com/')

      const persistedUsers = JSON.parse(dataStore.getItem('users'))
      assert.equal(persistedUsers[0].login, 'joan')
      assert.equal(persistedUsers[0].endpoint, 'https://api.whatever.ghe.com/')
    })

    it('does NOT migrate GHE users already using the api. subdomain', async () => {
      const dataStore = new InMemoryStore()
      dataStore.setItem(
        'users',
        JSON.stringify([
          {
            login: 'joan',
            endpoint: 'https://api.whatever.ghe.com/',
            token: 'deadbeef',
            emails: [],
            avatarURL: '',
            id: 1,
            name: '',
            plan: 'free',
          },
        ])
      )
      accountsStore = new AccountsStore(dataStore, new AsyncInMemoryStore())

      const users = await accountsStore.getAll()
      assert.equal(users[0].login, 'joan')
      assert.equal(users[0].endpoint, 'https://api.whatever.ghe.com/')

      const persistedUsers = JSON.parse(dataStore.getItem('users'))
      assert.equal(persistedUsers[0].login, 'joan')
      assert.equal(persistedUsers[0].endpoint, 'https://api.whatever.ghe.com/')
    })

    it('does NOT migrate GHES users still using /api/v3 to api. subdomain', async () => {
      const dataStore = new InMemoryStore()
      dataStore.setItem(
        'users',
        JSON.stringify([
          {
            login: 'joan',
            endpoint: 'https://my-company-repos.com/api/v3',
            token: 'deadbeef',
            emails: [],
            avatarURL: '',
            id: 1,
            name: '',
            plan: 'free',
          },
        ])
      )
      accountsStore = new AccountsStore(dataStore, new AsyncInMemoryStore())

      const users = await accountsStore.getAll()
      assert.equal(users[0].login, 'joan')
      assert.equal(users[0].endpoint, 'https://my-company-repos.com/api/v3')

      const persistedUsers = JSON.parse(dataStore.getItem('users'))
      assert.equal(persistedUsers[0].login, 'joan')
      assert.equal(
        persistedUsers[0].endpoint,
        'https://my-company-repos.com/api/v3'
      )
    })
  })

  describe('syncing from IPC', () => {
    it('loads synced users with tokens from secure storage', async () => {
      const dataStore = new InMemoryStore()
      const secureStore = new AsyncInMemoryStore()
      accountsStore = new AccountsStore(dataStore, secureStore)

      const account = new Account(
        'joan',
        'https://api.github.com',
        'deadbeef',
        [],
        '',
        1,
        'Joan',
        'free'
      )
      await secureStore.setItem(
        getKeyForAccount(account),
        account.login,
        account.token
      )

      let syncStateDuringUpdate: boolean | null = null
      accountsStore.onDidUpdate(() => {
        syncStateDuringUpdate = accountsStore.isSyncing
      })

      await accountsStore.syncFromIPC(JSON.stringify([account.withToken('')]))

      const users = await accountsStore.getAll()
      assert.equal(users.length, 1)
      assert.equal(users[0].login, 'joan')
      assert.equal(users[0].token, 'deadbeef')
      assert.equal(syncStateDuringUpdate, true)
      assert.equal(accountsStore.isSyncing, false)

      const persistedUsers = JSON.parse(dataStore.getItem('users'))
      assert.equal(persistedUsers[0].login, 'joan')
      assert.equal(persistedUsers[0].token, '')
    })

    it('restores rotating credentials and retires sessions removed by IPC', async () => {
      const dataStore = new InMemoryStore()
      const secureStore = new AsyncInMemoryStore()
      const source = new AccountsStore(dataStore, secureStore)
      const account = new Account(
        'joan',
        'https://api.github.com',
        'old-access',
        [],
        '',
        1,
        'Joan'
      )
      await source.addAccount(account, {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: 0,
      })
      let refreshCalls = 0
      const receiver = new AccountsStore(
        new InMemoryStore(),
        secureStore,
        async () => {
          refreshCalls++
          return {
            accessToken: 'new-access',
            refreshToken: 'new-refresh',
            expiresAt: Date.now() + 8 * 60 * 60_000,
          }
        }
      )
      await receiver.syncFromIPC(dataStore.getItem('users'))
      const [synced] = await receiver.getAll()
      assert.equal(synced.token, 'old-access')
      assert.equal(receiver.isRefreshable(synced), true)
      assert.equal(
        (await receiver.getAccountWithFreshToken(synced)).token,
        'new-access'
      )
      assert.equal(refreshCalls, 1)

      await receiver.syncFromIPC('[]')
      assert.deepEqual(await receiver.getAll(), [])
      await assert.rejects(
        receiver.resolveToken(account.endpoint, 'new-access')
      )
    })

    it('ignores invalid IPC payloads without changing existing accounts', async () => {
      const account = new Account(
        'joan',
        'https://api.github.com',
        'deadbeef',
        [],
        '',
        1,
        'Joan',
        'free'
      )
      await accountsStore.addAccount(account)

      await accountsStore.syncFromIPC('{not json')

      const users = await accountsStore.getAll()
      assert.equal(users.length, 1)
      assert.equal(users[0].login, 'joan')
      assert.equal(users[0].token, 'deadbeef')
    })
  })
})
