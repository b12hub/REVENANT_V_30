// =============================================================================
// internal/crypto/dispatcher.go
// REVENANT Gateway — SEDA Crypto Verification Dispatcher
// =============================================================================

package crypto

import (
	"crypto/ed25519"
	"runtime"
	"sync"
)

const (
	ed25519PublicKeySize = 32
	ed25519SignatureSize = 64
)

type VerifyJob struct {
	PubKeyArr [ed25519PublicKeySize]byte
	SigArr    [ed25519SignatureSize]byte
	Message   []byte
	ResultCh  chan bool
}

type Dispatcher struct {
	workCh     chan *VerifyJob
	jobPool    sync.Pool
	wg         sync.WaitGroup
	NumWorkers int
}

func NewDispatcher(numWorkers int) *Dispatcher {
	d := &Dispatcher{
		workCh:     make(chan *VerifyJob, numWorkers*4),
		NumWorkers: numWorkers,
	}

	d.jobPool = sync.Pool{
		New: func() interface{} {
			return &VerifyJob{
				ResultCh: make(chan bool, 1),
			}
		},
	}

	d.wg.Add(numWorkers)
	for i := 0; i < numWorkers; i++ {
		go d.worker()
	}

	return d
}

func (d *Dispatcher) worker() {
	defer d.wg.Done()

	// HFT MAGIC: Lock this goroutine to a physical OS thread.
	runtime.LockOSThread()

	for job := range d.workCh {
		result := ed25519.Verify(job.PubKeyArr[:], job.Message, job.SigArr[:])
		job.ResultCh <- result
	}
}

func (d *Dispatcher) DispatchVerify(pubKey, message, sig []byte) bool {
	job := d.jobPool.Get().(*VerifyJob)

	copy(job.PubKeyArr[:], pubKey)
	copy(job.SigArr[:], sig)
	job.Message = message

	d.workCh <- job
	result := <-job.ResultCh

	// Defensive Drain
	select {
	case <-job.ResultCh:
	default:
	}

	job.Message = nil
	d.jobPool.Put(job)

	return result
}

func (d *Dispatcher) Shutdown() {
	close(d.workCh)
	d.wg.Wait()
}
