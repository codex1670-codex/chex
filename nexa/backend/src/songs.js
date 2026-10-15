// Section: Notes music attachment. This is the "Spotify" song picker for notes — a
// fixed catalog standing in for a real Spotify Web API search, since this slice has no
// Spotify OAuth/client-credentials integration wired up. Every note can carry at most
// one of these tracks; `id` is what's actually stored/validated, title/artist/language/
// previewUrl are display + playback metadata sent along so the client doesn't need a
// second round trip to render or play it.
//
// Titles and artists below are real, well-known Tamil-film and English-chart songs
// (a snapshot compiled ~Sept 2026) — but this is a hardcoded list, not a live chart
// feed, so it will drift out of date. Treat it as a starting catalog: update the two
// arrays below (or replace this module with a real Spotify Web API search call) to
// keep it current. We stopped short of padding either list with guessed titles/artists
// just to hit a round number — every entry here is one we could actually verify, since
// a wrong composer/singer credit is worse than a shorter list.
//
// previewUrl points at freely-licensed instrumental demo tracks (not the real commercial
// recording implied by title/artist) so the picker can actually play something — swap
// these for real Spotify 30s preview URLs if/when this is wired up to the real API.
const DEMO_PREVIEWS = [
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3',
];

const TAMIL_TRACKS = [
  ['Manasilaayo', 'Anirudh Ravichander'], ['Hunter Vantaar', 'Sean Roldan'], ['Uchathila', 'Sean Roldan'],
  ['Adi Alaye', 'G.V. Prakash Kumar'], ['Ratnamala', 'G.V. Prakash Kumar'], ['Namakkana Kaalam', 'G.V. Prakash Kumar'],
  ['Thalapathy Kacheri', 'Anirudh Ravichander'], ['Chikitu', 'Anirudh Ravichander'], ['Monica', 'Anirudh Ravichander'],
  ['Salambala', 'Sai Abhyankkar'], ['Kannae Kanmaniye', 'A.R. Rahman'], ['Vaama Vaama', 'Dhanush'],
  ['Goindhamma', 'Hiphop Tamizha'], ['Kurumugil', 'Sai Vignesh'], ['Loveah Sollitalea', 'G.V. Prakash Kumar'],
  ['Yethu', 'A.R. Rahman'], ['Rummy Rummy', 'A.R. Rahman'], ['Yamma Ghajini', 'Asal Kolaar'],
  ['Kanaga', 'Yuvan Shankar Raja'], ['Kannumuzhi', 'Anthony Daasan'], ['Theekkoluthi', 'Nivas K. Prasanna'],
  ['Thaai Kizhavi Vaaraa', 'Sivakarthikeyan'], ['Kalloorum', 'G.V. Prakash Kumar'], ['Kanima', 'Santhosh Narayanan'],
  ['Chillanjirukkiye', 'Sean Roldan'], ['Rasagulla', 'Vishnu Edavan'], ['Abdi Abdi', 'A.R. Rahman'],
  ['Marandhu Poche', 'Sean Roldan'], ['Aiyo Kadhaley', 'Sean Roldan'], ['Pattuma', 'Anirudh Ravichander'],
  ['Esa Kaaththa', 'Sean Roldan'], ['Kannamma En Kannamma', 'Dhanush'], ['Pookattum', 'Anirudh Ravichander'],
  ['Pattampoochi', 'G.V. Prakash Kumar'], ['Kaadhal Kadhai', 'Sean Roldan'], ['Why This Kolaveri Di', 'Anirudh Ravichander'],
  ['Selfie Pulla', 'Anirudh Ravichander'], ['Rowdy Baby', 'Dhanush & Dhee'], ['Enjoy Enjaami', 'Dhee & Arivu'],
  ['Vaathi Coming', 'Anirudh Ravichander'], ['Kutti Story', 'Anirudh Ravichander'], ['Arabic Kuthu', 'Anirudh Ravichander'],
  ['Halamithi Habibo', 'Anirudh Ravichander'], ['Naa Ready', 'Anirudh Ravichander'], ['Kaavaalaa', 'Anirudh Ravichander'],
  ['Ranjithame', 'Anirudh Ravichander'], ['Munbe Vaa', 'A.R. Rahman'], ['Nenjukkul Peidhidum', 'A.R. Rahman'],
  ['Chinna Chinna Aasai', 'A.R. Rahman'], ['Vinnaithaandi Varuvaayaa', 'A.R. Rahman'],
];

const ENGLISH_TRACKS = [
  ['The Fate of Ophelia', 'Taylor Swift'], ['Opalite', 'Taylor Swift'], ['Man I Need', 'Olivia Dean'],
  ['Folded', 'Kehlani'], ['Back to Friends', 'Sombr'], ["Choosin' Texas", 'Ella Langley'],
  ['End of Beginning', 'Djo'], ['I Just Might', 'Bruno Mars'], ['Aperture', 'Harry Styles'],
  ['The Great Divide', 'Noah Kahan'], ['Risk It All', 'Bruno Mars'], ['Stateside', 'PinkPantheress & Zara Larsson'],
  ['American Girls', 'Harry Styles'], ['Hate That I Made You Love Me', 'Ariana Grande'], ['Been By Now', 'Morgan Wallen'],
  ['Flowers', 'Miley Cyrus'], ['As It Was', 'Harry Styles'], ['Espresso', 'Sabrina Carpenter'],
  ['Please Please Please', 'Sabrina Carpenter'], ['Good Luck, Babe!', 'Chappell Roan'], ['Not Like Us', 'Kendrick Lamar'],
  ['Fortnight', 'Taylor Swift ft. Post Malone'], ['Cruel Summer', 'Taylor Swift'], ['Anti-Hero', 'Taylor Swift'],
  ['Lose Control', 'Teddy Swims'], ['Stick Season', 'Noah Kahan'], ['Snooze', 'SZA'],
  ['Kill Bill', 'SZA'], ['Vampire', 'Olivia Rodrigo'], ['Bad Idea Right?', 'Olivia Rodrigo'],
  ['Greedy', 'Tate McRae'], ['Die With A Smile', 'Lady Gaga & Bruno Mars'], ['Birds of a Feather', 'Billie Eilish'],
  ['Lunch', 'Billie Eilish'], ["Texas Hold 'Em", 'Beyoncé'], ['16 Carriages', 'Beyoncé'],
  ['APT.', 'ROSÉ & Bruno Mars'], ['Beautiful Things', 'Benson Boone'], ['Houdini', 'Dua Lipa'],
  ['Training Season', 'Dua Lipa'], ['I Had Some Help', 'Post Malone ft. Morgan Wallen'], ['Paint the Town Red', 'Doja Cat'],
  ['Agora Hills', 'Doja Cat'], ['Rich Baby Daddy', 'Drake ft. Sexyy Red & SZA'], ['First Person Shooter', 'Drake ft. J. Cole'],
  ['Water', 'Tyla'], ['Peaches', 'Justin Bieber'], ['Stay', 'The Kid LAROI & Justin Bieber'],
  ['Calm Down', 'Rema & Selena Gomez'], ['Unholy', 'Sam Smith & Kim Petras'], ['Last Night', 'Morgan Wallen'],
  ['I Remember Everything', 'Zach Bryan ft. Kacey Musgraves'], ["Thinkin' Bout Me", 'Morgan Wallen'], ['Blue', 'Yung Kai'],
  ['Sunroof', 'Nicky Youre & dazy'], ['Yes, And?', 'Ariana Grande'], ["We Can't Be Friends", 'Ariana Grande'],
  ['7 rings', 'Ariana Grande'], ['Levitating', 'Dua Lipa'], ['Blinding Lights', 'The Weeknd'],
  ['Save Your Tears', 'The Weeknd'], ['Watermelon Sugar', 'Harry Styles'], ['Golden', 'Harry Styles'],
  ['Late Night Talking', 'Harry Styles'], ['Cuff It', 'Beyoncé'], ['Break My Soul', 'Beyoncé'],
  ["drivers license", 'Olivia Rodrigo'], ['good 4 u', 'Olivia Rodrigo'], ['deja vu', 'Olivia Rodrigo'],
  ['traitor', 'Olivia Rodrigo'], ['Easy On Me', 'Adele'], ['Oh My God', 'Adele'],
  ['Circles', 'Post Malone'], ['Sunflower', 'Post Malone & Swae Lee'], ['Industry Baby', 'Lil Nas X & Jack Harlow'],
  ['Old Town Road', 'Lil Nas X'], ['MONTERO (Call Me By Your Name)', 'Lil Nas X'], ['Ghost', 'Justin Bieber'],
  ['Believer', 'Imagine Dragons'], ['Thunder', 'Imagine Dragons'], ['Sweater Weather', 'The Neighbourhood'],
  ["Say You Won't Let Go", 'James Arthur'], ['Perfect', 'Ed Sheeran'], ['Shape of You', 'Ed Sheeran'],
  ['Bad Habits', 'Ed Sheeran'], ['Photograph', 'Ed Sheeran'], ['Havana', 'Camila Cabello'],
  ['Señorita', 'Shawn Mendes & Camila Cabello'], ['Stitches', 'Shawn Mendes'], ['Treat You Better', 'Shawn Mendes'],
  ['Location', 'Khalid'], ['Talk', 'Khalid'], ['Memories', 'Maroon 5'],
  ['Sugar', 'Maroon 5'], ['Girls Like You', 'Maroon 5'], ['Uptown Funk', 'Mark Ronson ft. Bruno Mars'],
  ['24K Magic', 'Bruno Mars'], ["That's What I Like", 'Bruno Mars'], ['Leave The Door Open', 'Silk Sonic'],
  ['Skate', 'Silk Sonic'],
];

function buildCatalog(tracks, prefix, language) {
  return tracks.map(([title, artist], i) => ({
    id: `${prefix}-${i + 1}`,
    title,
    artist,
    language,
    previewUrl: DEMO_PREVIEWS[i % DEMO_PREVIEWS.length],
  }));
}

export const SONGS = [
  ...buildCatalog(TAMIL_TRACKS, 'ta', 'tamil'),
  ...buildCatalog(ENGLISH_TRACKS, 'en', 'english'),
];

export function findSong(songId) {
  return SONGS.find(s => s.id === songId) || null;
}
