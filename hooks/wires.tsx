import type { ClientModule } from 'claude-code'

import type { WireCell } from './graph'

export type WiresProps = { wires: WireCell[]; width: number; height: number; isPaused: boolean }

const FRAME_MS = 160
const PULSE_EVERY = 4

// Runs on the drawing thread: its frame clock moves the pulses with no hook round trip.
const Wires: ClientModule<WiresProps, number> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    surface.every(FRAME_MS, () => surface.setState((surface.state ?? 0) + 1))
    surface.setState(0)
  }
  const phase = props.isPaused ? -1 : (surface.state ?? 0)

  return (
    <Box width={props.width} height={props.height}>
      {props.wires.map(w => {
        const isPulse = phase >= 0 && w.step !== undefined && (w.step - phase) % PULSE_EVERY === 0

        return (
          <Box position="absolute" top={w.y} left={w.x}>
            <Text color={w.color} dimColor={w.dim} bold={isPulse}>
              {isPulse ? '•' : w.ch}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

export default Wires
