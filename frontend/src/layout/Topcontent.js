import React, { Component } from 'react'

export class Topcontent extends Component {
    render() {
        return (
        	<div>
		        <div className="right-align">
		            <i className='fi flaticon-user-1' /> {this.props.user.email}
		        </div>
		    </div>
        )
    }
}
