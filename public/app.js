const $ = (sel, root = document) => root.querySelector(sel)

const LIST_SIZE = Number(document.body.dataset.listSize) || 38
const VOTING_OPEN = document.body.dataset.votingOpen === 'true'

const toast = (message, kind = 'info') => {
  let host = $('#toast')
  if (!host) {
    host = document.createElement('div')
    host.id = 'toast'
    document.body.append(host)
  }
  const note = document.createElement('div')
  note.className = `toast ${kind}`
  note.textContent = message
  host.append(note)
  setTimeout(() => note.classList.add('out'), 2600)
  setTimeout(() => note.remove(), 3200)
}

const postJSON = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.message || 'Something went wrong.')
  return data
}

/* ------------------------------------------------------------- voting ---- */

const paintButton = (button, voted) => {
  button.classList.toggle('voted', voted)
  button.setAttribute('aria-pressed', voted ? 'true' : 'false')
  const label = $('.vote-label', button)
  if (label) label.textContent = voted ? 'Voted' : 'Vote'
}

const syncBallotMeter = (votesUsed, maxVotes) => {
  const pips = document.querySelectorAll('.pips .pip')
  pips.forEach((pip, i) => pip.classList.toggle('on', i < votesUsed))
  const counter = $('.ballot-status b')
  if (counter) counter.textContent = String(votesUsed)
  document.querySelectorAll('button[data-vote]').forEach((button) => {
    const voted = button.getAttribute('aria-pressed') === 'true'
    button.disabled = !voted && votesUsed >= maxVotes
  })
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-vote]')
  if (!button) return
  event.preventDefault()
  if (button.disabled) return

  const did = button.dataset.vote
  const wasVoted = button.getAttribute('aria-pressed') === 'true'
  button.disabled = true
  paintButton(button, !wasVoted)

  try {
    const result = await postJSON('/api/vote', { did })
    document.querySelectorAll(`button[data-vote="${CSS.escape(did)}"]`).forEach((el) => paintButton(el, result.voted))
    document.querySelectorAll(`b[data-count="${CSS.escape(did)}"]`).forEach((el) => {
      el.textContent = new Intl.NumberFormat('en-US').format(result.votes)
    })
    syncBallotMeter(result.votesUsed, result.maxVotes)
    if (!result.voted) toast('Vote taken back.')
  } catch (err) {
    paintButton(button, wasVoted)
    toast(err.message, 'error')
  } finally {
    button.disabled = false
    if (button.getAttribute('aria-pressed') !== 'true') {
      const used = document.querySelectorAll('.pips .pip.on').length
      const total = document.querySelectorAll('.pips .pip').length
      if (total && used >= total) button.disabled = true
    }
  }
})

/* ------------------------------------------------------------- search ---- */

const resultsList = $('#results')
const searchInput = $('#q')

/** One row of a list of accounts. Shared by search results and the leaderboard's Load more. */
const buildRow = (actor, { rank, votesUsed, maxVotes } = {}) => {
  const li = document.createElement('li')
  li.className = 'row'
  li.dataset.did = actor.did

  if (rank !== undefined && rank !== null) {
    const rankEl = document.createElement('span')
    rankEl.className = `rank ${rank <= LIST_SIZE ? 'in' : 'out'}`
    rankEl.textContent = String(rank)
    li.append(rankEl)
  }

  const who = document.createElement('a')
  who.className = 'who'
  who.href = `/profile/${actor.did}`

  if (actor.avatar) {
    const img = document.createElement('img')
    img.className = 'avatar md'
    img.src = actor.avatar
    img.alt = ''
    img.loading = 'lazy'
    who.append(img)
  } else {
    const ph = document.createElement('span')
    ph.className = 'avatar md placeholder'
    ph.textContent = (actor.displayName || actor.handle || actor.did).charAt(0).toUpperCase()
    who.append(ph)
  }

  const names = document.createElement('span')
  names.className = 'names'
  const name = document.createElement('span')
  name.className = 'name'
  name.textContent = actor.displayName || actor.handle || actor.did
  const handle = document.createElement('span')
  handle.className = 'handle'
  handle.textContent = actor.handle ? `@${actor.handle}` : actor.did
  names.append(name, handle)
  who.append(names)

  const tally = document.createElement('span')
  tally.className = 'tally'
  const count = document.createElement('b')
  count.dataset.count = actor.did
  count.textContent = new Intl.NumberFormat('en-US').format(actor.votes ?? 0)
  const unit = document.createElement('small')
  unit.textContent = actor.votes === 1 ? 'vote' : 'votes'
  tally.append(count, unit)

  li.append(who, tally)

  if (document.body.dataset.signedIn === 'true') {
    const button = document.createElement('button')
    button.className = `btn btn-vote${actor.voted ? ' voted' : ''}`
    button.dataset.vote = actor.did
    button.setAttribute('aria-pressed', actor.voted ? 'true' : 'false')
    button.disabled = !actor.voted && votesUsed >= maxVotes
    const label = document.createElement('span')
    label.className = 'vote-label'
    label.textContent = actor.voted ? 'Voted' : 'Vote'
    button.append(label)
    li.append(button)
  } else if (VOTING_OPEN) {
    const link = document.createElement('a')
    link.className = 'btn btn-vote'
    link.href = '/login?next=%2Fvote'
    link.textContent = 'Vote'
    li.append(link)
  }

  return li
}

const renderResults = (data) => {
  resultsList.replaceChildren()
  if (data.actors.length === 0) {
    const empty = document.createElement('li')
    empty.className = 'muted pad'
    empty.textContent = 'Nobody by that name.'
    resultsList.append(empty)
    return
  }
  for (const actor of data.actors) {
    resultsList.append(buildRow(actor, { votesUsed: data.votesUsed, maxVotes: data.maxVotes }))
  }
}

/* ---------------------------------------------------------- load more ---- */

const loadMore = document.querySelector('#load-more')
const restBoard = document.querySelector('#rest-board')

loadMore?.addEventListener('click', async () => {
  const offset = Number(loadMore.dataset.offset)
  const limit = Number(loadMore.dataset.limit) || 24
  loadMore.disabled = true
  const original = loadMore.textContent
  loadMore.textContent = 'Loading…'

  try {
    const res = await fetch(`/api/leaderboard?offset=${offset}&limit=${limit}`)
    const data = await res.json()
    if (!res.ok) throw new Error(data.message || 'Could not load more.')

    for (const entry of data.entries) {
      restBoard.append(buildRow(entry, { rank: entry.rank, votesUsed: data.votesUsed, maxVotes: data.maxVotes }))
    }

    if (data.hasMore && data.entries.length > 0) {
      loadMore.dataset.offset = String(data.nextOffset)
      loadMore.textContent = original
      loadMore.disabled = false
    } else {
      loadMore.remove()
    }
  } catch (err) {
    toast(err.message, 'error')
    loadMore.textContent = original
    loadMore.disabled = false
  }
})

if (searchInput && resultsList) {
  let timer
  let seq = 0

  const run = async () => {
    const q = searchInput.value.trim()
    if (q.length < 2) return resultsList.replaceChildren()
    const mine = ++seq
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`)
      const data = await res.json()
      if (mine !== seq) return
      renderResults(data)
    } catch {
      /* a dropped search is not worth a toast */
    }
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(timer)
    timer = setTimeout(run, 220)
  })
  searchInput.form?.addEventListener('submit', (event) => {
    event.preventDefault()
    clearTimeout(timer)
    run()
  })
  if (searchInput.value.trim().length >= 2) run()
}

/* ------------------------------------------------- nominee self-controls ---- */

const optOut = $('#optout')
optOut?.addEventListener('click', async () => {
  const wanted = optOut.dataset.optout === 'true'
  optOut.disabled = true
  try {
    await postJSON('/api/profile', { optOut: wanted })
    location.reload()
  } catch (err) {
    toast(err.message, 'error')
    optOut.disabled = false
  }
})

$('#pin-form')?.addEventListener('submit', async (event) => {
  event.preventDefault()
  const input = event.target.elements.pinnedPost
  try {
    await postJSON('/api/profile', { pinnedPost: input.value.trim() })
    toast('Pinned.')
    setTimeout(() => location.reload(), 600)
  } catch (err) {
    toast(err.message, 'error')
  }
})
