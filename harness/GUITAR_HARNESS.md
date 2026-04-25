# Beatly Guitar Harness

이 문서는 Beatly의 기타 악보 추출/렌더링 계약이다.
기존 `harness/PROJECT_HARNESS.md`의 드럼 계약을 대체하지 않으며, 기타 트랙을 추가하거나 수정할 때 함께 따라야 한다.

## Ultimate Goal

- 사용자는 MP3 파일을 업로드한다.
- 시스템은 실제 기타리스트가 바로 읽고 연주할 수 있는 기타 악보를 생성한다.
- 결과물은 리듬이 보이는 표준 오선보 + 6줄 타브를 기본으로 하며, 숫자만 있는 "리듬 없는 타브"를 출력하지 않는다.
- 기타 음표와 한국어 가사는 같은 시간축을 공유하며, 가사는 기타 음표와 분리된 독립 Lyric Lane에 겹침 없이 유지된다.

## Default Output Contract

- 기본 렌더 모드는 `both`다.
- `both`: treble staff + 6-line TAB를 같은 마디/슬롯 축으로 정렬한다.
- `tab`: 예외적 지원 모드다. TAB만 보여도 리듬 정보가 사라지면 안 된다.
- `standard`: 내보내기 또는 고급 사용자용 보조 모드다. 기본값으로 쓰지 않는다.
- 기타 오선보는 treble clef 기준으로 렌더링하되, `midi_note`는 실제 울리는 음높이를 유지한다.
- `staff_key`는 기타 표기 관습에 맞는 written pitch를 사용한다. 실제 음고와 표기 음고를 혼동하지 않는다.

## Mandatory Rules

- 모든 기타 트랙은 튜닝을 반드시 명시한다.
- 튜닝 기본값은 표준 튜닝 `E2 A2 D3 G3 B3 E4`다.
- 탭의 맨 위 줄은 1번 줄 `e`, 맨 아래 줄은 6번 줄 `E`다.
- 모든 기타 음표는 최소 다음 정보를 가져야 한다: `measure`, `slot`, `duration`, `midi_note`, `string`, `fret`.
- 같은 시간에 동시에 치는 음은 같은 슬롯에 수직 정렬되어야 한다.
- 리듬이 없는 fret number 나열은 허용하지 않는다.
- 템포와 박자를 항상 함께 유지한다. 기본 박자는 `4/4`지만, 실제 곡 박자를 알면 그 값을 우선한다.
- 마디 구분은 항상 명확해야 하며, 반복/구조 정보가 있으면 `Verse`, `Chorus`, `Bridge`, `||: :||` 같은 표기를 보존한다.
- 모든 이벤트는 최소 16분 음표 슬롯으로 정렬한다.
- 32분/64분 음표나 그에 준하는 과도한 세분화는 1차 구현에서 만들지 않는다.
- 지속되는 음은 동일 숫자를 반복 찍지 말고 `duration`, `tie_to_next`, `tie_from_previous`로 표현한다.
- 코드(Chord)는 한 슬롯 안에서 여러 줄에 배치하되, 실제로 잡을 수 있는 보이싱을 우선한다.
- 같은 음고의 포지션 후보가 여러 개면 손 위치 이동이 최소가 되는 string/fret 조합을 선택한다.
- 연속 프레이즈는 가능한 한 같은 포지션 박스 안에 머무르게 한다.
- 슬라이드, 해머링, 풀링은 같은 줄에서 이어지는 음에만 붙인다.
- 벤드는 fretted note에만 붙이며, 목표 굽힘량이 없으면 기호를 만들지 않는다.
- 비브라토는 지속 시간이 있는 음에만 붙인다.
- 데드 노트/뮤트는 `X` 또는 `x` 성격이 드러나는 별도 기법으로 다루고 일반 음과 혼동하지 않는다.
- 팜뮤트는 저음현의 짧고 반복적인 어택 위주 패턴에서만 붙인다.
- 스트럼 방향(up/down)은 신뢰도가 충분할 때만 넣고, 불확실하면 생략한다.
- 가사는 기타 음표의 `lyric` 필드에만 의존하지 말고 독립 가사 슬롯으로 보존한다.

## Recommended Payload Shape

기타는 베이스와 같은 `Spec` 계층을 별도로 가져야 한다. 드럼의 `midi_ticks` 파생 렌더만으로는 string/fret/technique를 보존할 수 없다.

```text
instrumentType = "GUITAR"
guitarSpec.mode = "standard" | "tab" | "both"
guitarSpec.tuning = ["E4", "B3", "G3", "D3", "A2", "E2"]  # string 1 -> 6
guitarSpec.capo = 0
guitarSpec.notes[] = {
  id,
  time,
  measure,
  slot,
  duration,          # "w" | "h" | "q" | "8" | "16"
  duration_slots,    # 16, 8, 4, 2, 1
  midi_note,         # actual sounding pitch
  staff_key,         # written pitch for treble staff rendering
  string,            # 1..6
  fret,              # 0..24 or "X"
  chord,
  chord_group,
  lyric,
  confidence,
  techniques,        # e.g. HAMMER_ON, PULL_OFF, SLIDE, BEND, VIBRATO, PALM_MUTE, DEAD
  bend_amount,       # "quarter" | "half" | "full" | null
  slide_direction,   # "up" | "down" | null
  pick_direction,    # "down" | "up" | null
  tie_to_next,
  tie_from_previous,
  slur_to_next,
  slur_from_previous,
  prefer_string
}
```

## Hard Constraints

- 연주 불가능한 string/fret 조합을 만들지 않는다.
- 한 음표는 한 줄에만 배치한다. 같은 note event가 여러 줄로 중복되면 안 된다.
- 튜닝/카포를 고려했을 때 `midi_note != open_string_pitch + fret`인 상태를 허용하지 않는다.
- 카포를 추정할 근거가 약하면 자동으로 넣지 않는다. 기본은 `capo = 0`이다.
- 근거가 약한데 임의로 Drop D, Eb tuning, Open tuning을 선언하지 않는다.
- 같은 슬롯에 7개 이상의 동시음을 만들지 않는다.
- fretted chord의 유효 fret span이 과도하게 넓은데 barre/개방현 설명이 없으면 폐기하거나 단순화한다.
- 해머링/풀링/슬라이드를 다른 줄 사이에 붙이지 않는다.
- bend release는 선행 bend가 없으면 만들지 않는다.
- 리듬 정보가 없는 tab-only 출력을 허용하지 않는다.
- 후처리 중 `lyric=None`으로 기존 가사 슬롯을 증발시키지 않는다.

## Technical Pipeline Contract

1. Demucs는 최소 `vocals`, `drums`, `bass`, `other`를 확보할 수 있는 full stem 모드를 사용한다.
2. 기타 분석은 `other` stem을 기본 입력으로 삼고, 필요하면 건반/패드 성분을 줄이는 추가 마스킹을 수행한다.
3. 기타는 단선율 악기가 아니므로 `pyin` 단일 pitch 추정만으로 끝내지 않는다. polyphonic note-event 추출기를 사용한다.
4. 프레임 단위 pitch 후보를 onset/offset과 함께 note event로 묶는다.
5. 같은 onset의 note event를 chord group으로 클러스터링한다.
6. 각 sounding pitch에 대해 가능한 string/fret 후보를 전부 생성한다.
7. 포지션 솔버는 다음 비용을 최소화하는 방향으로 경로를 고른다:
   - 큰 fret 점프
   - 불필요한 줄 이동
   - 같은 프레이즈 안의 잦은 포지션 전환
   - 비현실적인 chord span
   - technique와 맞지 않는 줄 변경
8. technique 추론은 pitch contour와 인접 note 관계를 기반으로 한다.
9. 리듬은 1/16 슬롯에 정렬하고, duration/tie로 읽기 좋게 합친다.
10. 프론트엔드는 표준 오선보와 TAB를 같은 슬롯 축으로 그려서 vertical alignment를 보장한다.
11. Lyric Lane은 기타 음표 아래에서 독립적으로 렌더링한다.

## Position Selection Rules

- 첫 구현은 표준 튜닝 기준 `0~24`프렛 범위만 지원한다.
- 같은 음이 여러 줄에서 가능하면 아래 우선순위를 따른다:
  1. 현재 포지션과 fret distance가 가장 작은 후보
  2. 이전/다음 음과 같은 줄에서 technique 연결이 가능한 후보
  3. chord shape 전체 span이 가장 작은 후보
  4. 개방현 남용으로 프레이즈가 끊기지 않는 후보
- slide는 같은 줄의 상하 fret 이동으로만 표현한다.
- hammer-on/pull-off는 같은 줄에서 인접한 두 음 사이에만 붙인다.
- bend는 일반적으로 1~3번 줄 우선, 충분한 sustain과 pitch rise 증거가 있을 때만 붙인다.
- palm mute는 4~6번 줄 중심 리프에서 우선 검토한다.

## Rhythm And Technique Rules

- quarter/eighth/sixteenth 리듬은 표준 오선보에서 반드시 읽혀야 한다.
- TAB 숫자는 리듬과 분리되지 않게 같은 마디 구조를 공유한다.
- dead note는 일반 fret number가 아니라 `X` 성격이 드러나야 한다.
- harmonic, grace note, tremolo picking, artificial harmonic 같은 고급 기법은 1차 구현 범위에서 기본 제외한다.
- 1차 구현의 기본 technique 집합은 `HAMMER_ON`, `PULL_OFF`, `SLIDE`, `BEND`, `VIBRATO`, `PALM_MUTE`, `DEAD`다.
- strum direction 표기는 chord attack 신뢰도가 높은 경우에만 사용한다.

## Acceptance Gates

- API 응답에는 `instrumentType="GUITAR"`인 explicit track가 존재해야 한다.
- 기타 explicit track는 `guitarSpec`을 포함해야 한다.
- `guitarSpec.tuning`은 항상 6개 문자열을 가져야 한다.
- 모든 guitar note는 `string in 1..6`, `fret in 0..24 or "X"`를 만족해야 한다.
- 모든 guitar note는 `duration`과 `duration_slots`를 가져야 한다.
- 모든 guitar note는 마디/슬롯 좌표로 역산 가능해야 한다.
- `midi_note`는 튜닝/카포/프렛과 일치해야 한다.
- 같은 `measure + slot + chord_group`에 속한 음들은 렌더 시 수직 정렬되어야 한다.
- `HAMMER_ON`, `PULL_OFF`, `SLIDE`는 연결된 note pair가 같은 줄에 있어야 한다.
- `BEND`가 있으면 `bend_amount`가 비어 있으면 안 된다.
- 표준 오선보와 TAB의 마디 수, 슬롯 수, 재생 커서 좌표가 일치해야 한다.
- `words`에 존재하는 가사는 기타 렌더의 Lyric Lane에도 남아 있어야 한다.
- 기본 렌더 모드는 `both`여야 한다.

## MVP Scope

처음부터 모든 기타 표현을 다 맞추려 하지 말고 아래 순서로 구현한다.

1. 표준 튜닝, single-note riff, power chord, open chord, basic chord grouping
2. `both` 렌더, 16분 슬롯 리듬, lyric lane 동기화
3. hammer-on / pull-off / slide / dead note / palm mute
4. bend / vibrato / strum direction
5. alternate tuning / capo / section repeat / 고급 기법

## Repository Fit

- 백엔드: `BassSpec`와 별도로 `GuitarSpec` 계층을 추가한다.
- 프론트엔드: `MelodicSheet.tsx` 파생 staff-only 렌더로 끝내지 말고, 기타 전용 `GuitarSheet.tsx`를 둔다.
- 렌더링은 `BassSheet.tsx`의 "standard + tab + lyric lane" 구조를 6줄 기타 TAB 기준으로 확장하는 방향을 우선한다.
- 현재의 derived guitar view는 임시 fallback일 뿐, 최종 기타 악보 계약으로 간주하지 않는다.
