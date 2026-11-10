/**
* 公演紹介ページ（ランディングページ・R39）の文面データ。
*
* このファイルが LP の文面の唯一の置き場。画面側（LandingPage.tsx）は
* ここにある内容をそのまま並べるだけにし、文面の差し替えはこのファイルの
* 編集だけで完結するようにしてある。
*
*
* 劇団の歴史・過去公演・観客の声・キャスト紹介・会場アクセスは、劇団から
* 実素材が届くまで空（空配列）にしておくこと。空のセクションは画面に
* 出ない（「準備中」のような仮表示もしない）。創立年・過去の公演名・
* お客様の声・出演者名などを推測で書いてはいけない。
* pendingLpSlots() が、未投入のスロット名を返す（運用確認・テスト用）。
*
* ここに実文が入っているのは、ポスターの文言・公演の確定情報
* （作品名／2027年5月／会場／料金／座席の仕組み）だけを根拠に書ける範囲。
* あらすじ・見どころも、ポスターに描かれたモチーフと作品名から
* 読み取れる範囲に留めてある（上演内容の詳細は劇団に確認して直すこと）。
*/

export interface LpHistoryEntry {
/** 年・時期の表記（例: 「2019年」）。劇団から届いた表記のまま入れる */
year: string
text: string
}

export interface LpTestimonial {
quote: string
/** 掲載してよい形の属性表記（例: 「30代・女性」）。実名は載せない */
attribution: string
}

export interface LpCastEntry {
/** 役名（例: 「桃太郎」）。役名が未確定なら空文字にせず、投入自体を待つ */
role: string
/** 出演者名（劇団が公開可とした表記のみ） */
name: string
/** 本人の一言コメント */
comment: string
}

export interface LpFaqEntry {
question: string
answer: string
}

export interface LpContent {
/** ポスターのキャッチコピー（ポスターの文言どおり） */
catchCopy: string
/** 作品名 */
showTitle: string
/** ジャンル表記 */
genre: string
/** 公演時期の表記（ポスターの文言どおり） */
periodLabel: string
/** あらすじ（段落ごと） */
synopsis: string[]
/** 見どころ（箇条書き） */
highlights: string[]
/** 劇団紹介の本文（確定情報のみ） */
aboutParagraphs: string[]
/** 劇団の歩み（劇団からの実素材待ち。空ならセクション自体を出さない） */
history: LpHistoryEntry[]
/** 過去の公演（劇団からの実素材待ち） */
pastProductions: string[]
/** 観客の声（実素材待ち。捏造禁止） */
testimonials: LpTestimonial[]
/** キャスト紹介（顔写真は使わない。名前＋役名＋一言のみ。実素材待ち） */
cast: LpCastEntry[]
/** 会場アクセスの案内文（実素材待ち。住所・最寄り駅などを推測で書かない） */
venueAccess: string[]
/** よくある質問（予約の仕組みなど確定情報のみ） */
faq: LpFaqEntry[]
}

export const LP_CONTENT: LpContent = {
catchCopy: 'おとぎ話の世界へ ―想像力の翼をひらいて―',
showTitle: 'おとぎ話管理局',
genre: '劇団ツインリーブス オリジナルミュージカル',
periodLabel: '2027年5月・1日限りの特別公演',
synopsis: [
'「おとぎ話管理局」——それは、世界中のおとぎ話がこれからも正しく語り継がれていくよう見守る、少し不思議な役所のお話。桃太郎やシンデレラ、ジャックと豆の木など、誰もが知るおとぎ話のモチーフが次々に登場する、劇団ツインリーブスのオリジナルミュージカルです。',
'小さなお子さまから大人まで、家族みんなで楽しめるファンタジーの世界へご案内します。',
],
highlights: [
'誰もが知るおとぎ話のキャラクターたちが集う、にぎやかで心温まる物語',
'舞台いっぱいに広がるプロジェクション映像が描く、絵本のような世界',
'歌とダンスで紡ぐ、劇団ツインリーブスのオリジナルミュージカル',
],
aboutParagraphs: [
'劇団ツインリーブス（Twin Leaves）は、オリジナルミュージカルを上演する劇団です。2027年5月、戸塚区民文化センター さくらプラザ・ホールにて、オリジナルミュージカル『おとぎ話管理局』を上演します。',
],
history: [],
pastProductions: [],
testimonials: [],
cast: [],
venueAccess: [],
faq: [
{
question: '座席は自分で選べますか？',
answer:
'1席ずつ選ぶのではなく、「ゾーン（エリア）と人数」を選ぶ方式です。選んだゾーンの中で並んだ席を自動でご用意し、お支払い時、または当日の受付時に座席が確定します。',
},
{
question: 'お支払いはいつ、どのようにしますか？',
answer:
'当日、会場の受付で現金でお支払いください。事前に劇団関係者からチケットをお求めの場合（手売り）は、その際にお支払いいただけます。',
},
{
question: '子供料金の対象を教えてください',
answer: '子供料金は小学生以下のお子さまが対象です。',
},
{
question: '車椅子席や親子室はありますか？',
answer:
'車椅子席2席、親子室6席をご用意しています。お申し込みフォームの「座席の希望」でお選びください。当日は受付で専用席をご案内します。',
},
{
question: '何名まで申し込めますか？',
answer:
'オンラインでは1回のお申し込みで8名までです。9名以上の場合は、続けて2回に分けてお申し込みいただくか、主催者へご連絡ください。',
},
{
question: '予約の確認やキャンセルはできますか？',
answer:
'画面上部の「予約確認」から、予約番号と電話番号でご予約内容の確認とキャンセルができます（お支払い済み・受付済みのご予約は、スタッフまでご連絡ください）。',
},
{
question: '当日は何を持っていけばいいですか？',
answer:
'予約番号（または予約完了画面のQRコード）と、チケット代金（現金）をお持ちください。受付でお名前と予約番号をお伝えいただいても大丈夫です。',
},
],
}

/**
* 未投入のコンテンツスロット名を返す。
* 劇団から実素材が届いたら LP_CONTENT に投入するだけで、対応する
* セクションが画面に現れる。残っているスロットの確認に使う。
*/
export function pendingLpSlots(content: LpContent = LP_CONTENT): string[] {
const pending: string[] = []
if (content.history.length === 0) pending.push('劇団の歴史（歩み）')
if (content.pastProductions.length === 0) pending.push('過去の公演一覧')
if (content.testimonials.length === 0) pending.push('観客の声')
if (content.cast.length === 0) pending.push('キャスト紹介（名前・役名・一言）')
if (content.venueAccess.length === 0) pending.push('会場アクセス（住所・交通案内）')
return pending
}
